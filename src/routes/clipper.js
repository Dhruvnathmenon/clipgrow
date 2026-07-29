import { json, err, readJson, matchPath } from '../http.js';
import { createSessionCookie, requireClipper, verifyPassword, clearCookieHeader } from '../auth.js';
import {
  now, getClipperByUsername, getClipperById, getCampaignById, getParticipation,
  getAccountById, publicCampaign, publicAccount, campaignSpend, clipperFinancials,
  clipperStreak, clipperTotals
} from '../db.js';
import { findMediaByUrl, isVideoMedia, IgError, IG_ERRORS } from '../instagram.js';
import { captureThumbnail } from '../media.js';
import { syncClipperViews } from '../earnings.js';

// Manual refresh cooldown. Instagram allows roughly 200 calls per user per
// hour and each clip costs one call, so this keeps a clipper well inside it
// even with a full 40-clip refresh every time.
const MANUAL_SYNC_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Ownership is proven against Instagram the moment a clip is pasted, so every
 * stored clip is "verified". Tracking is a separate axis: views only start
 * flowing once a sync succeeds, which can lag a few hours on fresh posts.
 */
function clipState(s) {
  if (s.status === 'disqualified') return 'disqualified';
  if (s.sync_error) return 'issue';
  if (!s.last_synced_at) return 'verified';
  return 'tracking';
}

function igErrorResponse(e, status = 400) {
  if (e instanceof IgError) return json({ error: e.message, fix: e.fix, code: e.code, needs_reauth: e.needsReauth }, status);
  return err(e.message || 'Something went wrong', status);
}

export async function handleClipper(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/clipper/login' && method === 'POST') {
    const { username, password } = await readJson(request);
    if (!username || !password) return err('Enter your username and password');
    const clipper = await getClipperByUsername(env.DB, username);
    if (!clipper) return err('Invalid username or password', 401);
    // Disabled clippers may still sign in, read-only, so they can verify any
    // balance still owed to them.
    const valid = await verifyPassword(password, clipper.password_hash, clipper.password_salt);
    if (!valid) return err('Invalid username or password', 401);
    const cookie = await createSessionCookie('clipper', clipper.id, env.SESSION_SECRET);
    return json({ ok: true }, 200, { 'Set-Cookie': cookie });
  }

  if (pathname === '/api/clipper/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookieHeader('cg_session') });
  }

  if (!pathname.startsWith('/api/clipper/')) return null;

  const session = await requireClipper(request, env);
  if (!session) return err('Unauthorized', 401);
  const clipperId = Number(session.sub);

  const me = await getClipperById(env.DB, clipperId);
  if (!me) return json({ error: 'Account no longer exists' }, 401, { 'Set-Cookie': clearCookieHeader('cg_session') });

  // A disabled account keeps read access to its own numbers but cannot act.
  const readOnly = me.status !== 'active';
  const blockIfReadOnly = () => readOnly
    ? err('Your account is disabled, so this action is not available. You can still see everything you have earned. Contact the ClipGrow admin.', 403)
    : null;

  // ------------------------------------------------------------- profile
  if (pathname === '/api/clipper/me' && method === 'GET') {
    const [money, streak, totals] = await Promise.all([
      clipperFinancials(env.DB, clipperId),
      clipperStreak(env.DB, clipperId),
      clipperTotals(env.DB, clipperId)
    ]);
    return json({
      clipper: {
        id: me.id, username: me.username,
        display_name: me.display_name || me.username,
        status: me.status, read_only: readOnly
      },
      money, streak, totals,
      refresh: {
        cooldown_ms: MANUAL_SYNC_COOLDOWN_MS,
        next_allowed_at: (me.last_manual_sync_at || 0) + MANUAL_SYNC_COOLDOWN_MS
      }
    });
  }

  // Every social account this clipper has linked, and which campaign each drives.
  if (pathname === '/api/clipper/accounts' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT a.*, c.name AS campaign_name, c.id AS campaign_id
       FROM social_accounts a
       LEFT JOIN participations p ON p.account_id = a.id
       LEFT JOIN campaigns c ON c.id = p.campaign_id
       WHERE a.clipper_id = ? ORDER BY a.connected_at DESC`
    ).bind(clipperId).all();
    return json({
      accounts: (results || []).map(r => ({
        ...publicAccount(r),
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name
      }))
    });
  }

  if (pathname === '/api/clipper/payments' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.amount, p.method, p.reference, p.note, p.paid_at, c.name AS campaign_name
       FROM payments p LEFT JOIN campaigns c ON c.id = p.campaign_id
       WHERE p.clipper_id = ? ORDER BY p.paid_at DESC`
    ).bind(clipperId).all();
    return json({ payments: results || [], money: await clipperFinancials(env.DB, clipperId) });
  }

  // ------------------------------------------------------------ campaigns
  if (pathname === '/api/clipper/campaigns' && method === 'GET') {
    const { results: campaigns } = await env.DB
      .prepare("SELECT * FROM campaigns WHERE status != 'completed' ORDER BY created_at DESC").all();
    const { results: parts } = await env.DB
      .prepare('SELECT * FROM participations WHERE clipper_id = ?').bind(clipperId).all();
    const byCampaign = new Map((parts || []).map(p => [p.campaign_id, p]));

    // Only needed while no account is connected, so fetch once up front
    // rather than a query per campaign.
    const { results: testerRows } = await env.DB
      .prepare('SELECT * FROM tester_requests WHERE clipper_id = ? ORDER BY requested_at DESC')
      .bind(clipperId).all();
    const latestTester = (testerRows && testerRows[0]) || null;

    const out = [];
    for (const c of campaigns || []) {
      const part = byCampaign.get(c.id);
      let account = null;
      if (part && part.account_id) account = publicAccount(await getAccountById(env.DB, part.account_id));
      const stats = await env.DB.prepare(
        `SELECT COUNT(*) AS videos, COALESCE(SUM(views),0) AS views, COALESCE(SUM(earning),0) AS earned
         FROM submissions WHERE clipper_id = ? AND campaign_id = ? AND status = 'active'`
      ).bind(clipperId, c.id).first();

      out.push({
        ...publicCampaign(c, await campaignSpend(env.DB, c.id)),
        participation: part
          ? {
              status: part.status, note: part.status_note, joined_at: part.joined_at, account,
              tester: account ? null : (latestTester
                ? { ig_username: latestTester.ig_username, status: latestTester.status }
                : null)
            }
          : null,
        my_stats: { videos: stats.videos, views: stats.views, earned: stats.earned }
      });
    }
    return json({ campaigns: out });
  }

  let params = matchPath('/api/clipper/campaigns/:id/join', pathname);
  if (params && method === 'POST') {
    const blocked = blockIfReadOnly();
    if (blocked) return blocked;
    const campaign = await getCampaignById(env.DB, params.id);
    if (!campaign) return err('Campaign not found', 404);
    if (campaign.status === 'completed') return err('This campaign is over and is no longer accepting clippers');
    if (campaign.status === 'budget_full') return err('This campaign\'s budget is fully allocated, so it is closed to new clippers');

    const existing = await getParticipation(env.DB, clipperId, params.id);
    if (existing) {
      if (existing.status === 'kicked') return err('You have been removed from this campaign. Contact the ClipGrow admin.', 403);
      return json({ ok: true, already: true });
    }
    await env.DB.prepare(
      'INSERT INTO participations (clipper_id, campaign_id, status, joined_at) VALUES (?, ?, ?, ?)'
    ).bind(clipperId, params.id, 'active', now()).run();
    return json({ ok: true }, 201);
  }

  // Detach the connected account from a campaign so a different one can be linked.
  params = matchPath('/api/clipper/campaigns/:id/account', pathname);
  if (params && method === 'DELETE') {
    const blocked = blockIfReadOnly();
    if (blocked) return blocked;
    const part = await getParticipation(env.DB, clipperId, params.id);
    if (!part) return err('You have not joined this campaign', 404);
    const used = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM submissions WHERE clipper_id = ? AND campaign_id = ? AND status = 'active'"
    ).bind(clipperId, params.id).first();
    if (used.n > 0) {
      return err('You already have videos submitted with this account. Ask the ClipGrow admin to change it so your earnings stay intact.', 409);
    }
    await env.DB.prepare('UPDATE participations SET account_id = NULL WHERE id = ?').bind(part.id).run();
    return json({ ok: true });
  }

  // ------------------------------------------------- Instagram tester queue
  // Manual gate ahead of the OAuth flow: the Meta app is in Development Mode,
  // so an Instagram account must be an accepted app Tester before OAuth can
  // ever succeed for it. The admin adds/confirms testers by hand in Meta; this
  // just tracks that step so a clipper isn't left guessing why Connect fails.
  if (pathname === '/api/clipper/tester-request' && method === 'POST') {
    const blocked = blockIfReadOnly();
    if (blocked) return blocked;
    const body = await readJson(request);
    const igUsername = String(body.ig_username || '').trim().replace(/^@/, '');
    if (!igUsername) return err('Enter your Instagram username');
    const campaignId = body.campaign_id ? Number(body.campaign_id) : null;

    const existing = await env.DB.prepare(
      'SELECT * FROM tester_requests WHERE clipper_id = ? AND ig_username = ? COLLATE NOCASE'
    ).bind(clipperId, igUsername).first();
    if (existing) return json({ ok: true, request: existing });

    const res = await env.DB.prepare(
      'INSERT INTO tester_requests (clipper_id, ig_username, status, campaign_id, requested_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(clipperId, igUsername, 'requested', campaignId, now()).run();
    const created = await env.DB.prepare('SELECT * FROM tester_requests WHERE id = ?').bind(res.meta.last_row_id).first();
    return json({ ok: true, request: created }, 201);
  }

  // ----------------------------------------------------------- submissions
  // ------------------------------------------------------- manual refresh
  if (pathname === '/api/clipper/refresh' && method === 'POST') {
    const blocked = blockIfReadOnly();
    if (blocked) return blocked;

    const last = me.last_manual_sync_at || 0;
    const waitMs = last + MANUAL_SYNC_COOLDOWN_MS - Date.now();
    if (waitMs > 0) {
      return json({
        error: `Views were just refreshed. You can refresh again in ${Math.ceil(waitMs / 1000)}s.`,
        retry_in_ms: waitMs
      }, 429);
    }

    // Stamp before syncing: if the sync throws halfway, the cooldown still
    // applies, so a failing account can't be retried in a tight loop.
    await env.DB.prepare('UPDATE clippers SET last_manual_sync_at = ? WHERE id = ?')
      .bind(Date.now(), clipperId).run();

    const result = await syncClipperViews(env.DB, clipperId);
    const money = await clipperFinancials(env.DB, clipperId);
    const totals = await clipperTotals(env.DB, clipperId);
    return json({ ok: true, ...result, money, totals, cooldown_ms: MANUAL_SYNC_COOLDOWN_MS });
  }

  if (pathname === '/api/clipper/submissions' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT s.id, s.permalink, s.views, s.earning, s.status, s.sync_error, s.created_at, s.last_synced_at,
              s.thumbnail_key, s.thumbnail_url, s.media_product_type, s.posted_at,
              c.name AS campaign_name, c.id AS campaign_id, c.cpm,
              a.username AS account_username, a.platform
       FROM submissions s
       JOIN campaigns c ON c.id = s.campaign_id
       LEFT JOIN social_accounts a ON a.id = s.account_id
       WHERE s.clipper_id = ? ORDER BY s.created_at DESC`
    ).bind(clipperId).all();

    return json({
      clips: (results || []).map(s => ({
        id: s.id,
        campaign_id: s.campaign_id,
        campaign_name: s.campaign_name,
        permalink: s.permalink,
        platform: s.platform || 'instagram',
        account_username: s.account_username,
        views: s.views,
        earning: s.earning,
        cpm: s.cpm,
        state: clipState(s),
        has_thumb: !!(s.thumbnail_key || s.thumbnail_url),
        thumb: `/api/media/thumb/${s.id}`,
        created_at: s.created_at,
        posted_at: s.posted_at,
        last_synced_at: s.last_synced_at
      }))
    });
  }

  if (pathname === '/api/clipper/submissions' && method === 'POST') {
    const blocked = blockIfReadOnly();
    if (blocked) return blocked;
    const { campaign_id, url: postUrl } = await readJson(request);
    if (!campaign_id || !postUrl) return err('Pick a campaign and paste your post link');

    const campaign = await getCampaignById(env.DB, campaign_id);
    if (!campaign) return err('Campaign not found', 404);
    if (campaign.status === 'completed') return err('This campaign is over — it is no longer accepting new videos');
    if (campaign.status === 'budget_full') return err('This campaign\'s budget is fully allocated, so new videos can no longer earn');

    const part = await getParticipation(env.DB, clipperId, campaign_id);
    if (!part) return err('Join this campaign before submitting a video');
    if (part.status === 'kicked') return err('You have been removed from this campaign. Contact the ClipGrow admin.', 403);
    if (part.status === 'paused') return err('Your participation in this campaign is paused, so new videos cannot be submitted right now.', 403);
    if (!part.account_id) return err('Connect the Instagram account for this campaign before submitting a video');

    const account = await getAccountById(env.DB, part.account_id);
    if (!account || account.status === 'revoked') return err('The Instagram account for this campaign is disconnected. Reconnect it to continue.');
    if (account.status === 'needs_reauth') {
      return json({ error: 'The Instagram connection for this campaign has expired.', fix: 'Click Reconnect on this campaign, then submit again.', code: 'TOKEN_EXPIRED', needs_reauth: true }, 400);
    }

    let media;
    try {
      media = await findMediaByUrl(account.external_id, account.access_token, postUrl);
    } catch (e) {
      if (e instanceof IgError && e.needsReauth) {
        await env.DB.prepare('UPDATE social_accounts SET status = ?, last_error_code = ?, last_error_at = ? WHERE id = ?')
          .bind('needs_reauth', e.code, now(), account.id).run();
      }
      return igErrorResponse(e, 502);
    }

    if (!media) return igErrorResponse(IG_ERRORS.MEDIA_NOT_FOUND());
    if (!isVideoMedia(media)) return igErrorResponse(IG_ERRORS.NOT_VIDEO());

    const dup = await env.DB.prepare('SELECT id, clipper_id FROM submissions WHERE ig_media_id = ?').bind(media.id).first();
    if (dup) {
      return err(dup.clipper_id === clipperId ? 'You have already submitted this video' : 'This video has already been submitted', 409);
    }

    // Best-effort preview capture; a missing image never blocks submission.
    const thumbSource = media.thumbnail_url || media.media_url || null;
    const thumbKey = await captureThumbnail(env, media.id, thumbSource);

    await env.DB.prepare(
      `INSERT INTO submissions (clipper_id, campaign_id, account_id, ig_media_id, permalink, views, earning,
         status, created_at, thumbnail_key, thumbnail_url, media_product_type, posted_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 'active', ?, ?, ?, ?, ?)`
    ).bind(
      clipperId, campaign_id, account.id, media.id, media.permalink, now(),
      thumbKey, thumbSource, media.media_product_type || media.media_type || null,
      media.timestamp ? Date.parse(media.timestamp) || null : null
    ).run();

    return json({ ok: true, message: 'Clip verified and added — views start tracking on the next sync' }, 201);
  }

  // ------------------------------------------------------------ directory
  // Only active clippers, ranked by earnings. Totals only: no payment status,
  // no campaign breakdown, no individual clip links.
  if (pathname === '/api/clipper/directory' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT cl.id, cl.username, cl.display_name,
              COALESCE(SUM(s.views),0) AS views,
              COALESCE(SUM(s.earning),0) AS earned
       FROM clippers cl
       LEFT JOIN submissions s ON s.clipper_id = cl.id AND s.status = 'active'
       WHERE cl.status = 'active'
       GROUP BY cl.id
       ORDER BY earned DESC, views DESC, cl.display_name ASC`
    ).all();

    return json({
      clippers: (results || []).map((c, i) => ({
        id: c.id,
        rank: i + 1,
        display_name: c.display_name || c.username,
        views: c.views,
        earned: c.earned,
        is_me: c.id === clipperId
      }))
    });
  }

  return null;
}
