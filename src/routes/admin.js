import { json, err, readJson, matchPath } from '../http.js';
import { createSessionCookie, requireAdmin, hashPassword, clearCookieHeader } from '../auth.js';
import {
  now, publicClipper, publicAccount, publicCampaign, pickBlueprint,
  campaignSpend, campaignWithSpend, clipperFinancials, getCampaignById, normalizeUsername, slugify
} from '../db.js';
import { syncAllCampaigns, reallocateCampaign } from '../earnings.js';
import { parseBlueprintDocx } from '../blueprint.js';
import { payableClips, settlePayment, reversePayment, writeOffAllBelowMin } from '../payouts.js';
import { exportClipsCsv, exportPaymentsCsv } from '../export.js';
import { PLATFORMS, campaignPlatforms, configuredPlatforms } from '../platforms.js';
import { debugMediaInsights } from '../instagram.js';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const CAMPAIGN_STATUSES = ['active', 'budget_full', 'completed'];
const PART_STATUSES = ['active', 'paused', 'kicked'];

/**
 * Sanitises the platform list for a campaign. Falls back to Instagram when the
 * input is empty or unrecognised, so a bad value can never silently open a
 * campaign to a platform the brand did not agree to.
 */
function normalisePlatforms(input) {
  const list = (Array.isArray(input) ? input : String(input || '').split(','))
    .map(s => String(s).trim().toLowerCase())
    .filter(p => PLATFORMS.includes(p));
  return ([...new Set(list)].join(',')) || 'instagram';
}

export async function handleAdmin(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/admin/login' && method === 'POST') {
    const { password } = await readJson(request);
    if (!password || !env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) return err('Incorrect password', 401);
    const cookie = await createSessionCookie('admin', 'admin', env.SESSION_SECRET);
    return json({ ok: true }, 200, { 'Set-Cookie': cookie });
  }

  if (pathname === '/api/admin/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookieHeader('cg_session') });
  }

  if (!pathname.startsWith('/api/admin/')) return null;

  const session = await requireAdmin(request, env);
  if (!session) return err('Unauthorized', 401);

  // ------------------------------------------------------------- overview
  if (pathname === '/api/admin/overview' && method === 'GET') {
    // A single sync_error is normal noise -- a transient rate limit clears on
    // the next 6-hourly cycle. What actually needs a human is a clip that has
    // gone TWO cycles (12h+) without a single successful sync despite
    // presumably being retried each time: that is a genuinely stuck clip, not
    // a blip, and this is the number that would have surfaced the batch-
    // isolation bug immediately instead of only being found by hand.
    const STUCK_AFTER_MS = 12 * 60 * 60 * 1000;
    const s = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM clippers WHERE status='active') AS active_clippers,
        (SELECT COUNT(*) FROM campaigns WHERE status='active') AS active_campaigns,
        (SELECT COALESCE(SUM(earning),0) FROM submissions WHERE status='active') AS total_earned,
        (SELECT COALESCE(SUM(amount),0) FROM payments) AS total_paid,
        (SELECT COUNT(*) FROM social_accounts WHERE status='needs_reauth') AS accounts_needing_reauth,
        (SELECT COUNT(*) FROM submissions WHERE sync_error IS NOT NULL AND status='active') AS submissions_with_errors,
        (SELECT COUNT(*) FROM submissions
           WHERE sync_error IS NOT NULL AND status='active' AND locked_at IS NULL
             AND (last_ok_sync_at IS NULL OR last_ok_sync_at < ?)) AS submissions_stuck`
    ).bind(Date.now() - STUCK_AFTER_MS).first();
    return json({ overview: { ...s, outstanding: Math.max(0, (s.total_earned || 0) - (s.total_paid || 0)) } });
  }

  // ------------------------------------------------------- blueprint parse
  if (pathname === '/api/admin/campaigns/parse' && method === 'POST') {
    let form;
    try {
      form = await request.formData();
    } catch {
      return err('Expected a file upload');
    }
    const file = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') return err('No file received');
    if (file.size > MAX_UPLOAD_BYTES) return err('File is too large (max 5MB)');
    if (!/\.docx$/i.test(file.name || '')) return err('Please upload a Word .docx blueprint');
    try {
      const draft = await parseBlueprintDocx(await file.arrayBuffer());
      return json({ draft, source_filename: file.name });
    } catch (e) {
      return err(`Could not read that blueprint: ${e.message}`, 422);
    }
  }

  // -------------------------------------------------------------- clippers
  if (pathname === '/api/admin/clippers' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM clippers ORDER BY created_at DESC').all();
    const out = [];
    for (const c of results || []) {
      const money = await clipperFinancials(env.DB, c.id);
      const acc = await env.DB.prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN status!='connected' THEN 1 ELSE 0 END) AS bad
         FROM social_accounts WHERE clipper_id = ?`).bind(c.id).first();
      const parts = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM participations WHERE clipper_id = ? AND status != 'kicked'").bind(c.id).first();
      out.push({ ...publicClipper(c), money, accounts: acc.n, accounts_unhealthy: acc.bad || 0, campaigns: parts.n });
    }
    return json({ clippers: out });
  }

  if (pathname === '/api/admin/clippers' && method === 'POST') {
    const { username, password, display_name } = await readJson(request);
    if (!username || !password) return err('Username and password are required');
    if (String(password).length < 6) return err('Password must be at least 6 characters');
    const clean = normalizeUsername(username);
    if (!clean) return err('Username cannot be blank');
    const existing = await env.DB
      .prepare('SELECT id FROM clippers WHERE username = ? COLLATE NOCASE').bind(clean).first();
    if (existing) return err('That username is already taken', 409);
    const { hash, salt } = await hashPassword(password);
    const res = await env.DB.prepare(
      'INSERT INTO clippers (username, password_hash, password_salt, display_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(clean, hash, salt, display_name || clean, 'active', now()).run();
    return json({ ok: true, id: res.meta.last_row_id, username: clean }, 201);
  }

  let params = matchPath('/api/admin/clippers/:id', pathname);
  if (params && method === 'GET') {
    const clipper = await env.DB.prepare('SELECT * FROM clippers WHERE id = ?').bind(params.id).first();
    if (!clipper) return err('Not found', 404);
    const { results: accounts } = await env.DB.prepare('SELECT * FROM social_accounts WHERE clipper_id = ?').bind(params.id).all();
    const { results: parts } = await env.DB.prepare(
      `SELECT p.*, c.name AS campaign_name, a.username AS account_username, a.status AS account_status
       FROM participations p JOIN campaigns c ON c.id = p.campaign_id
       LEFT JOIN social_accounts a ON a.id = p.account_id
       WHERE p.clipper_id = ?`).bind(params.id).all();
    const { results: subs } = await env.DB.prepare(
      `SELECT s.*, c.name AS campaign_name FROM submissions s JOIN campaigns c ON c.id = s.campaign_id
       WHERE s.clipper_id = ? ORDER BY s.created_at DESC`).bind(params.id).all();
    const { results: pays } = await env.DB.prepare(
      `SELECT p.*, c.name AS campaign_name FROM payments p LEFT JOIN campaigns c ON c.id = p.campaign_id
       WHERE p.clipper_id = ? ORDER BY p.paid_at DESC`).bind(params.id).all();
    return json({
      clipper: publicClipper(clipper),
      money: await clipperFinancials(env.DB, params.id),
      accounts: (accounts || []).map(publicAccount),
      participations: parts || [],
      submissions: subs || [],
      payments: pays || []
    });
  }

  if (params && method === 'PATCH') {
    const { status, display_name, password } = await readJson(request);
    if (status && !['active', 'disabled'].includes(status)) return err('Invalid status');
    if (status) await env.DB.prepare('UPDATE clippers SET status = ? WHERE id = ?').bind(status, params.id).run();
    if (display_name != null) await env.DB.prepare('UPDATE clippers SET display_name = ? WHERE id = ?').bind(display_name, params.id).run();
    if (password) {
      if (String(password).length < 6) return err('Password must be at least 6 characters');
      const { hash, salt } = await hashPassword(password);
      await env.DB.prepare('UPDATE clippers SET password_hash = ?, password_salt = ? WHERE id = ?').bind(hash, salt, params.id).run();
    }
    return json({ ok: true });
  }

  if (params && method === 'DELETE') {
    const subs = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions WHERE clipper_id = ?').bind(params.id).first();
    if (subs.n > 0) return err(`This clipper has ${subs.n} submitted video(s). Disable the account instead so their earnings history is kept.`, 409);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM participations WHERE clipper_id = ?').bind(params.id),
      env.DB.prepare('DELETE FROM social_accounts WHERE clipper_id = ?').bind(params.id),
      env.DB.prepare('DELETE FROM payments WHERE clipper_id = ?').bind(params.id),
      env.DB.prepare('DELETE FROM clippers WHERE id = ?').bind(params.id)
    ]);
    return json({ ok: true });
  }

  // ------------------------------------------------------------- campaigns
  if (pathname === '/api/admin/campaigns' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all();
    const out = [];
    for (const c of results || []) {
      const parts = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM participations WHERE campaign_id = ? AND status != 'kicked'").bind(c.id).first();
      out.push({ ...(await campaignWithSpend(env.DB, c)), participants: parts.n });
    }
    return json({ campaigns: out });
  }

  if (pathname === '/api/admin/campaigns' && method === 'POST') {
    const payload = await readJson(request);
    const name = (payload.name || '').trim();
    if (!name) return err('Campaign name is required');
    const cpm = Number(payload.cpm) || 0;
    const budget = Number(payload.budget) || 0;
    if (cpm <= 0) return err('CPM must be greater than 0');
    if (budget <= 0) return err('Budget must be greater than 0');
    // Views a clip must reach before it earns anything. Defaults to 1,000.
    const minViews = payload.min_views != null ? Math.max(0, Number(payload.min_views) || 0) : 1000;
    const platforms = normalisePlatforms(payload.allowed_platforms);
    const res = await env.DB.prepare(
      `INSERT INTO campaigns (name, description, cpm, budget, min_views, status, model, blueprint_json, allowed_platforms, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
    ).bind(name, payload.description || '', cpm, budget, minViews, payload.model || '',
           JSON.stringify(pickBlueprint(payload)), platforms, now()).run();
    const id = res.meta.last_row_id;
    // Slug needs the id (for uniqueness), which only exists after insert --
    // set it in a follow-up UPDATE. Never changes after this, even if the
    // campaign is renamed later, so a shared /campaigns/:slug link never breaks.
    const slug = slugify(name, id);
    await env.DB.prepare('UPDATE campaigns SET slug = ? WHERE id = ?').bind(slug, id).run();
    return json({ ok: true, id, slug }, 201);
  }

  params = matchPath('/api/admin/campaigns/:id/participants', pathname);
  if (params && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.status, p.status_note, p.joined_at, p.clipper_id,
              cl.username, cl.display_name,
              a.username AS account_username, a.status AS account_status, a.account_type, a.last_error_code,
              (SELECT COUNT(*) FROM submissions s WHERE s.clipper_id=p.clipper_id AND s.campaign_id=p.campaign_id AND s.status='active') AS videos,
              (SELECT COALESCE(SUM(views),0) FROM submissions s WHERE s.clipper_id=p.clipper_id AND s.campaign_id=p.campaign_id AND s.status='active') AS views,
              (SELECT COALESCE(SUM(earning),0) FROM submissions s WHERE s.clipper_id=p.clipper_id AND s.campaign_id=p.campaign_id AND s.status='active') AS earned
       FROM participations p
       JOIN clippers cl ON cl.id = p.clipper_id
       LEFT JOIN social_accounts a ON a.id = p.account_id
       WHERE p.campaign_id = ? ORDER BY earned DESC`
    ).bind(params.id).all();
    return json({ participants: results || [] });
  }

  params = matchPath('/api/admin/campaigns/:id', pathname);
  if (params && method === 'GET') {
    const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(params.id).first();
    if (!campaign) return err('Not found', 404);
    const { results: submissions } = await env.DB.prepare(
      `SELECT s.id, s.permalink, s.views, s.earning, s.status, s.sync_error, s.created_at, s.last_synced_at, s.source, s.platform,
              cl.username, a.username AS account_username
       FROM submissions s JOIN clippers cl ON cl.id = s.clipper_id
       LEFT JOIN social_accounts a ON a.id = s.account_id
       WHERE s.campaign_id = ? ORDER BY s.created_at ASC`
    ).bind(params.id).all();
    return json({ campaign: await campaignWithSpend(env.DB, campaign), submissions: submissions || [] });
  }

  if (params && method === 'PATCH') {
    const payload = await readJson(request);
    const existing = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(params.id).first();
    if (!existing) return err('Not found', 404);
    if (payload.status && !CAMPAIGN_STATUSES.includes(payload.status)) return err('Invalid status');
    const merged = { ...JSON.parse(existing.blueprint_json || '{}'), ...pickBlueprint(payload) };
    await env.DB.prepare(
      `UPDATE campaigns SET name = ?, description = ?, cpm = ?, budget = ?, min_views = ?, status = ?, model = ?, blueprint_json = ?, allowed_platforms = ? WHERE id = ?`
    ).bind(
      payload.name != null ? String(payload.name).trim() || existing.name : existing.name,
      payload.description != null ? payload.description : existing.description,
      payload.cpm != null ? Number(payload.cpm) || existing.cpm : existing.cpm,
      payload.budget != null ? Number(payload.budget) || existing.budget : existing.budget,
      payload.min_views != null ? Math.max(0, Number(payload.min_views) || 0) : existing.min_views,
      payload.status || existing.status,
      payload.model != null ? payload.model : existing.model,
      JSON.stringify(merged),
      payload.allowed_platforms != null
        ? normalisePlatforms(payload.allowed_platforms)
        : (existing.allowed_platforms || 'instagram'),
      params.id
    ).run();
    // CPM, budget or threshold changes re-price every submission in this campaign.
    if (payload.cpm != null || payload.budget != null || payload.min_views != null) {
      await reallocateCampaign(env.DB, params.id);
    }
    return json({ ok: true });
  }

  if (params && method === 'DELETE') {
    const subCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions WHERE campaign_id = ?').bind(params.id).first();
    if (subCount.n > 0) {
      return err(`This campaign has ${subCount.n} submission(s). Mark it as over instead of deleting, so clipper earnings are preserved.`, 409);
    }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM participations WHERE campaign_id = ?').bind(params.id),
      env.DB.prepare('DELETE FROM campaigns WHERE id = ?').bind(params.id)
    ]);
    return json({ ok: true });
  }

  // --------------------------------------------------------- participations
  params = matchPath('/api/admin/participations/:id', pathname);
  if (params && method === 'PATCH') {
    const { status, note, account_id } = await readJson(request);
    const part = await env.DB.prepare('SELECT * FROM participations WHERE id = ?').bind(params.id).first();
    if (!part) return err('Not found', 404);
    if (status && !PART_STATUSES.includes(status)) return err('Invalid status');
    await env.DB.prepare(
      'UPDATE participations SET status = ?, status_note = ?, status_changed_at = ?, account_id = ? WHERE id = ?'
    ).bind(
      status || part.status,
      note != null ? note : part.status_note,
      status && status !== part.status ? now() : part.status_changed_at,
      account_id !== undefined ? account_id : part.account_id,
      params.id
    ).run();
    // Kicking or reinstating changes who earns, so the budget must be re-spread.
    if (status && status !== part.status) await reallocateCampaign(env.DB, part.campaign_id);
    return json({ ok: true });
  }

  if (params && method === 'DELETE') {
    const part = await env.DB.prepare('SELECT * FROM participations WHERE id = ?').bind(params.id).first();
    if (!part) return err('Not found', 404);
    const subs = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM submissions WHERE clipper_id = ? AND campaign_id = ?')
      .bind(part.clipper_id, part.campaign_id).first();
    if (subs.n > 0) return err(`This clipper has ${subs.n} video(s) in this campaign. Use Kick instead so their earnings are preserved.`, 409);
    await env.DB.prepare('DELETE FROM participations WHERE id = ?').bind(params.id).run();
    return json({ ok: true });
  }

  // -------------------------------------------------------- tester requests
  // Manual queue ahead of OAuth: the Meta app is in Development Mode, so an
  // Instagram account must be an accepted app Tester before a clipper's
  // Connect Instagram can ever succeed. The admin adds/confirms the tester by
  // hand in the Meta dashboard; these endpoints just track that state.
  const TESTER_STATUSES = ['requested', 'invited', 'confirmed', 'rejected'];

  if ((pathname === '/api/admin/access-requests' || pathname === '/api/admin/tester-requests') && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT t.*, COALESCE(t.identifier, t.ig_username) AS identifier,
              cl.username AS clipper_username, cl.display_name AS clipper_display_name,
              c.name AS campaign_name,
              -- Whether this exact account was already approved on another
              -- campaign. Tester/test-user status is app-level on both
              -- platforms, so if it was, there is nothing to do in Meta or
              -- Google Cloud and this can simply be approved.
              (SELECT COUNT(*) FROM tester_requests p
                WHERE p.clipper_id = t.clipper_id
                  AND p.platform = t.platform
                  AND COALESCE(p.identifier, p.ig_username) = COALESCE(t.identifier, t.ig_username)
                  AND p.status = 'confirmed' AND p.id != t.id) AS already_granted,
              -- Whether they have since connected, so a stale queue entry is
              -- visibly resolved rather than looking like outstanding work.
              (SELECT COUNT(*) FROM participation_accounts pa
                JOIN participations pp ON pp.id = pa.participation_id
                JOIN social_accounts sa ON sa.id = pa.account_id
                WHERE pp.clipper_id = t.clipper_id AND pp.campaign_id = t.campaign_id
                  AND pa.platform = t.platform AND sa.status != 'revoked') AS is_connected
       FROM tester_requests t
       JOIN clippers cl ON cl.id = t.clipper_id
       LEFT JOIN campaigns c ON c.id = t.campaign_id
       ORDER BY
         CASE t.status WHEN 'requested' THEN 0 WHEN 'invited' THEN 1 ELSE 2 END,
         t.requested_at DESC`
    ).all();
    return json({ requests: results || [] });
  }

  params = matchPath('/api/admin/access-requests/:id', pathname)
        || matchPath('/api/admin/tester-requests/:id', pathname);
  if (params && method === 'PATCH') {
    const { status, note } = await readJson(request);
    const reqRow = await env.DB.prepare('SELECT * FROM tester_requests WHERE id = ?').bind(params.id).first();
    if (!reqRow) return err('Not found', 404);
    if (status && !TESTER_STATUSES.includes(status)) return err('Invalid status');

    const nextStatus = status || reqRow.status;
    await env.DB.prepare(
      `UPDATE tester_requests SET status = ?, note = ?,
         invited_at = CASE WHEN ? = 'invited' AND invited_at IS NULL THEN ? ELSE invited_at END,
         confirmed_at = CASE WHEN ? = 'confirmed' AND confirmed_at IS NULL THEN ? ELSE confirmed_at END
       WHERE id = ?`
    ).bind(
      nextStatus, note != null ? note : reqRow.note,
      nextStatus, now(),
      nextStatus, now(),
      params.id
    ).run();
    return json({ ok: true });
  }

  // ------------------------------------------------------------------ guides
  // SEO content pages (src/routes/guides.js renders these publicly at
  // /guides and /guides/:slug). Managed entirely here -- publishing or
  // editing an article never requires a code deploy.
  if (pathname === '/api/admin/guides' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM guides ORDER BY created_at DESC').all();
    return json({ guides: results || [] });
  }

  if (pathname === '/api/admin/guides' && method === 'POST') {
    const payload = await readJson(request);
    const title = (payload.title || '').trim();
    if (!title) return err('Title is required');
    const bodyHtml = (payload.body_html || '').trim();
    if (!bodyHtml) return err('Body content is required');
    let slug = (payload.slug || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const existing = await env.DB.prepare('SELECT id FROM guides WHERE slug = ?').bind(slug).first();
    if (existing) return err('A guide with this slug already exists', 409);
    const res = await env.DB.prepare(
      `INSERT INTO guides (slug, title, meta_description, audience, target_keyword, body_html, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      slug, title, payload.meta_description || '', payload.audience === 'brand' ? 'brand' : 'clipper',
      payload.target_keyword || '', bodyHtml, payload.status === 'published' ? 'published' : 'draft', now()
    ).run();
    return json({ ok: true, id: res.meta.last_row_id, slug }, 201);
  }

  params = matchPath('/api/admin/guides/:id', pathname);
  if (params && method === 'PATCH') {
    const g = await env.DB.prepare('SELECT * FROM guides WHERE id = ?').bind(params.id).first();
    if (!g) return err('Not found', 404);
    const payload = await readJson(request);
    await env.DB.prepare(
      `UPDATE guides SET title = ?, meta_description = ?, audience = ?, target_keyword = ?, body_html = ?, status = ?, updated_at = ? WHERE id = ?`
    ).bind(
      payload.title != null ? String(payload.title).trim() || g.title : g.title,
      payload.meta_description != null ? payload.meta_description : g.meta_description,
      payload.audience === 'brand' || payload.audience === 'clipper' ? payload.audience : g.audience,
      payload.target_keyword != null ? payload.target_keyword : g.target_keyword,
      payload.body_html != null ? payload.body_html : g.body_html,
      payload.status === 'published' || payload.status === 'draft' ? payload.status : g.status,
      now(), params.id
    ).run();
    return json({ ok: true });
  }
  if (params && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM guides WHERE id = ?').bind(params.id).run();
    return json({ ok: true });
  }

  // ------------------------------------------------------------ submissions
  params = matchPath('/api/admin/submissions/:id', pathname);
  if (params && (method === 'PATCH' || method === 'DELETE')) {
    const sub = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(params.id).first();
    if (!sub) return err('Not found', 404);
    // A settled clip is closed history: real money was sent against this exact
    // amount. Editing or deleting it would rewrite the books and silently
    // desync the payment ledger. Reverse the payment first if it was a mistake.
    if (sub.locked_at) {
      return err('This clip is locked because it has already been settled. Reverse its payment first if you need to change it.', 409);
    }
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM submissions WHERE id = ?').bind(params.id).run();
    } else {
      // 'paused' = temporarily not monetised (under review, off-guidelines).
      // 'disqualified' = permanently rejected. Both earn nothing and hand their
      // share of the budget back; only 'active' accrues.
      const { status } = await readJson(request);
      if (!['active', 'paused', 'disqualified'].includes(status)) return err('Invalid status');
      await env.DB.prepare('UPDATE submissions SET status = ? WHERE id = ?').bind(status, params.id).run();
    }
    await reallocateCampaign(env.DB, sub.campaign_id);
    return json({ ok: true });
  }

  // --------------------------------------------------------------- accounts
  params = matchPath('/api/admin/accounts/:id', pathname);
  if (params && method === 'DELETE') {
    const inUse = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions WHERE account_id = ?').bind(params.id).first();
    if (inUse.n > 0) {
      // Keep the row (submissions reference it) but strip the credential.
      await env.DB.prepare(
        "UPDATE social_accounts SET status='revoked', access_token=NULL, token_expires_at=NULL WHERE id = ?"
      ).bind(params.id).run();
      return json({ ok: true, revoked: true });
    }
    await env.DB.batch([
      env.DB.prepare('UPDATE participations SET account_id = NULL WHERE account_id = ?').bind(params.id),
      env.DB.prepare('DELETE FROM social_accounts WHERE id = ?').bind(params.id)
    ]);
    return json({ ok: true });
  }

  // ---------------------------------------------------------------- payouts
  // Everything a payout run needs: each clip in the window with its posted and
  // synced dates, whether it cleared the campaign minimum, whether the
  // per-video cap bit, and what is already settled.
  params = matchPath('/api/admin/clippers/:id/payable', pathname);
  if (params && method === 'GET') {
    const clipper = await env.DB.prepare('SELECT id FROM clippers WHERE id = ?').bind(params.id).first();
    if (!clipper) return err('Clipper not found', 404);
    const daysRaw = url.searchParams.get('days');
    const days = daysRaw === 'all' ? 0 : Math.max(0, Number(daysRaw) || 30);
    const campaignId = url.searchParams.get('campaign_id') || null;
    const data = await payableClips(env.DB, Number(params.id), {
      days,
      campaignId: campaignId ? Number(campaignId) : null
    });
    return json({ ...data, days });
  }

  // One-click sweep: closes below-minimum, unlocked clips at zero, scoped to
  // a campaign/clipper if given or across everyone if not. Only touches a
  // clip whose clipper already had a payout run that should have covered it
  // (see writeOffAllBelowMin) -- a clip still waiting on its first-ever
  // payout is left alone, since it may still clear the minimum before then.
  // Money-neutral either way (these clips already earn 0).
  if (pathname === '/api/admin/payouts/write-off-below-min' && method === 'POST') {
    const body = await readJson(request).catch(() => ({}));
    const result = await writeOffAllBelowMin(env.DB, {
      campaignId: body.campaign_id ? Number(body.campaign_id) : null,
      clipperId: body.clipper_id ? Number(body.clipper_id) : null
    });
    return json(result);
  }

  // Records the payment AND locks every clip it covers, in one call. Locking is
  // what stops a clip being paid for twice and what stops its amount being
  // rewritten later.
  if (pathname === '/api/admin/payouts/settle' && method === 'POST') {
    const body = await readJson(request);
    if (!body.clipper_id) return err('Pick a clipper');
    const result = await settlePayment(env.DB, {
      clipperId: Number(body.clipper_id),
      submissionIds: Array.isArray(body.submission_ids) ? body.submission_ids : [],
      writeOffIds: Array.isArray(body.write_off_ids) ? body.write_off_ids : [],
      amount: body.amount,
      campaignId: body.campaign_id ? Number(body.campaign_id) : null,
      method: body.method,
      reference: body.reference,
      note: body.note,
      paidAt: body.paid_at
    });
    if (result.error) return json({ error: result.error, locked_ids: result.locked_ids }, result.status || 400);
    return json({ ...result, money: await clipperFinancials(env.DB, body.clipper_id) }, 201);
  }

  // Reopens a clip that was closed at zero for missing the campaign minimum.
  // Deliberately refuses clips locked by a payment: those must go back through
  // the payment reversal, so the ledger and the locks can never drift apart.
  params = matchPath('/api/admin/submissions/:id/unlock', pathname);
  if (params && method === 'POST') {
    const sub = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(params.id).first();
    if (!sub) return err('Not found', 404);
    if (!sub.locked_at) return err('This clip is not locked', 400);
    if (sub.lock_reason === 'paid') {
      return err('This clip was locked by a payment. Reverse that payment instead, so the ledger stays correct.', 409);
    }
    await env.DB.prepare(
      'UPDATE submissions SET locked_at = NULL, locked_earning = NULL, lock_reason = NULL WHERE id = ?'
    ).bind(params.id).run();
    await reallocateCampaign(env.DB, sub.campaign_id);
    return json({ ok: true });
  }

  params = matchPath('/api/admin/payments/:id/reverse', pathname);
  if (params && method === 'POST') {
    const result = await reversePayment(env.DB, Number(params.id));
    if (result.error) return json({ error: result.error }, result.status || 400);
    return json(result);
  }

  // --------------------------------------------------------------- payments
  if (pathname === '/api/admin/payments' && method === 'GET') {
    const clipperId = url.searchParams.get('clipper_id');
    const sql = clipperId
      ? `SELECT p.*, cl.username, c.name AS campaign_name FROM payments p
         JOIN clippers cl ON cl.id = p.clipper_id LEFT JOIN campaigns c ON c.id = p.campaign_id
         WHERE p.clipper_id = ? ORDER BY p.paid_at DESC`
      : `SELECT p.*, cl.username, c.name AS campaign_name FROM payments p
         JOIN clippers cl ON cl.id = p.clipper_id LEFT JOIN campaigns c ON c.id = p.campaign_id
         ORDER BY p.paid_at DESC LIMIT 200`;
    const stmt = clipperId ? env.DB.prepare(sql).bind(clipperId) : env.DB.prepare(sql);
    const { results } = await stmt.all();
    return json({ payments: results || [] });
  }

  if (pathname === '/api/admin/payments' && method === 'POST') {
    const { clipper_id, campaign_id, amount, method: payMethod, reference, note, paid_at } = await readJson(request);
    if (!clipper_id) return err('Pick a clipper');
    const amt = Math.round(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) return err('Amount must be greater than 0');
    const clipper = await env.DB.prepare('SELECT id FROM clippers WHERE id = ?').bind(clipper_id).first();
    if (!clipper) return err('Clipper not found', 404);
    if (campaign_id && !(await getCampaignById(env.DB, campaign_id))) return err('Campaign not found', 404);
    const res = await env.DB.prepare(
      `INSERT INTO payments (clipper_id, campaign_id, amount, method, reference, note, paid_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(clipper_id, campaign_id || null, amt, payMethod || 'UPI', reference || '', note || '',
           paid_at ? Number(paid_at) : now(), now()).run();
    return json({ ok: true, id: res.meta.last_row_id, money: await clipperFinancials(env.DB, clipper_id) }, 201);
  }

  params = matchPath('/api/admin/payments/:id', pathname);
  if (params && method === 'DELETE') {
    // Routed through the reversal so the clips this payment locked are released
    // too. Deleting the row on its own would strand them locked forever with a
    // dangling payment_id.
    const result = await reversePayment(env.DB, Number(params.id));
    if (result.error) return json({ error: result.error }, result.status || 400);
    return json(result);
  }
  if (params && method === 'PATCH') {
    const { amount, method: payMethod, reference, note, paid_at } = await readJson(request);
    const pay = await env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(params.id).first();
    if (!pay) return err('Not found', 404);
    const amt = amount != null ? Math.round(Number(amount)) : pay.amount;
    if (!Number.isFinite(amt) || amt <= 0) return err('Amount must be greater than 0');
    await env.DB.prepare(
      'UPDATE payments SET amount = ?, method = ?, reference = ?, note = ?, paid_at = ? WHERE id = ?'
    ).bind(amt, payMethod != null ? payMethod : pay.method, reference != null ? reference : pay.reference,
           note != null ? note : pay.note, paid_at != null ? Number(paid_at) : pay.paid_at, params.id).run();
    return json({ ok: true });
  }

  // ---------------------------------------------------------------- clients
  // Read-only observer logins for brands, scoped to the campaigns granted here.
  if (pathname === '/api/admin/clients' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM clients ORDER BY created_at DESC').all();
    const out = [];
    for (const c of results || []) {
      const { results: camps } = await env.DB.prepare(
        `SELECT c.id, c.name FROM client_campaigns cc JOIN campaigns c ON c.id = cc.campaign_id
         WHERE cc.client_id = ? ORDER BY c.created_at DESC`
      ).bind(c.id).all();
      out.push({
        id: c.id, username: c.username, company_name: c.company_name,
        contact_name: c.contact_name, status: c.status, created_at: c.created_at,
        campaigns: camps || []
      });
    }
    return json({ clients: out });
  }

  if (pathname === '/api/admin/clients' && method === 'POST') {
    const { username, password, company_name, contact_name, campaign_ids } = await readJson(request);
    if (!username || !password) return err('Username and password are required');
    if (String(password).length < 6) return err('Password must be at least 6 characters');
    const clean = normalizeUsername(username);
    if (!clean) return err('Username cannot be blank');
    const existing = await env.DB.prepare('SELECT id FROM clients WHERE username = ? COLLATE NOCASE').bind(clean).first();
    if (existing) return err('That client username is already taken', 409);
    const { hash, salt } = await hashPassword(password);
    const res = await env.DB.prepare(
      `INSERT INTO clients (username, password_hash, password_salt, company_name, contact_name, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`
    ).bind(clean, hash, salt, company_name || clean, contact_name || '', now()).run();
    const clientId = res.meta.last_row_id;
    for (const cid of Array.isArray(campaign_ids) ? campaign_ids : []) {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO client_campaigns (client_id, campaign_id, granted_at) VALUES (?, ?, ?)'
      ).bind(clientId, Number(cid), now()).run();
    }
    return json({ ok: true, id: clientId, username: clean }, 201);
  }

  params = matchPath('/api/admin/clients/:id', pathname);
  if (params && method === 'PATCH') {
    const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(params.id).first();
    if (!client) return err('Not found', 404);
    const { status, company_name, contact_name, password, campaign_ids } = await readJson(request);
    if (status && !['active', 'disabled'].includes(status)) return err('Invalid status');
    await env.DB.prepare(
      'UPDATE clients SET status = ?, company_name = ?, contact_name = ? WHERE id = ?'
    ).bind(status || client.status,
           company_name != null ? company_name : client.company_name,
           contact_name != null ? contact_name : client.contact_name, params.id).run();
    if (password) {
      if (String(password).length < 6) return err('Password must be at least 6 characters');
      const { hash, salt } = await hashPassword(password);
      await env.DB.prepare('UPDATE clients SET password_hash = ?, password_salt = ? WHERE id = ?')
        .bind(hash, salt, params.id).run();
    }
    // Campaign grants are replaced wholesale when supplied, so unticking a
    // campaign in the admin UI actually revokes that client's access to it.
    if (Array.isArray(campaign_ids)) {
      await env.DB.prepare('DELETE FROM client_campaigns WHERE client_id = ?').bind(params.id).run();
      for (const cid of campaign_ids) {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO client_campaigns (client_id, campaign_id, granted_at) VALUES (?, ?, ?)'
        ).bind(params.id, Number(cid), now()).run();
      }
    }
    return json({ ok: true });
  }

  if (params && method === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM client_campaigns WHERE client_id = ?').bind(params.id),
      env.DB.prepare('DELETE FROM clients WHERE id = ?').bind(params.id)
    ]);
    return json({ ok: true });
  }

  // ----------------------------------------------------------------- export
  // Offline backup of the books. Generated live from D1 on every request, so a
  // download is always a true snapshot of the current state -- the point being
  // that it still tells you what was paid for even if the site is down.
  if (pathname === '/api/admin/export.csv' && method === 'GET') {
    const kind = url.searchParams.get('type') === 'payments' ? 'payments' : 'clips';
    const csv = kind === 'payments'
      ? await exportPaymentsCsv(env.DB)
      : await exportClipsCsv(env.DB);
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="clipgrow-${kind}-${stamp}.csv"`,
        'Cache-Control': 'no-store'
      }
    });
  }

  // ------------------------------------------------------------------- sync
  if (pathname === '/api/admin/sync' && method === 'POST') {
    const summary = await syncAllCampaigns(env.DB, env);
    return json({ ok: true, ...summary });
  }

  // Diagnostic: shows every Instagram insights metric Meta will answer for one
  // clip's media, side by side, against the actual stored value. The access
  // token itself is read and used entirely server-side and never appears in
  // the response -- only the metric values Instagram returns do. Exists to
  // tell apart "our sync has a bug" from "Instagram's own API disagrees with
  // its own app" without ever having to extract a live credential by hand.
  params = matchPath('/api/admin/debug/submissions/:id/ig-metrics', pathname);
  if (params && method === 'GET') {
    const sub = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(params.id).first();
    if (!sub) return err('Not found', 404);
    if (sub.platform !== 'instagram') return err('This diagnostic is Instagram-only.', 400);
    const account = await env.DB.prepare('SELECT * FROM social_accounts WHERE id = ?').bind(sub.account_id).first();
    if (!account || !account.access_token) return err('No connected Instagram account for this clip.', 404);

    const diag = await debugMediaInsights(sub.ig_media_id, account.access_token);
    return json({
      submission_id: sub.id,
      permalink: sub.permalink,
      stored_views: sub.views,
      stored_last_ok_sync_at: sub.last_ok_sync_at,
      ...diag
    });
  }

  return null;
}
