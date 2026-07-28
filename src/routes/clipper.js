import { json, err, readJson, matchPath } from '../http.js';
import { createSessionCookie, requireClipper, verifyPassword, clearCookieHeader } from '../auth.js';
import {
  now, getClipperByUsername, getClipperById, getCampaignById, getParticipation,
  getAccountById, publicCampaign, publicAccount, campaignSpend, clipperFinancials
} from '../db.js';
import { findMediaByUrl, isVideoMedia, IgError, IG_ERRORS } from '../instagram.js';

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
    if (clipper.status !== 'active') {
      return err('This account has been disabled. Contact the ClipGrow admin.', 403);
    }
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
  if (!me) return err('Account no longer exists', 401, { 'Set-Cookie': clearCookieHeader('cg_session') });
  if (me.status !== 'active') {
    return json({ error: 'This account has been disabled. Contact the ClipGrow admin.' }, 403, {
      'Set-Cookie': clearCookieHeader('cg_session')
    });
  }

  // ------------------------------------------------------------- profile
  if (pathname === '/api/clipper/me' && method === 'GET') {
    const money = await clipperFinancials(env.DB, clipperId);
    return json({
      clipper: { id: me.id, username: me.username, display_name: me.display_name || me.username },
      money
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
          ? { status: part.status, note: part.status_note, joined_at: part.joined_at, account }
          : null,
        my_stats: { videos: stats.videos, views: stats.views, earned: stats.earned }
      });
    }
    return json({ campaigns: out });
  }

  let params = matchPath('/api/clipper/campaigns/:id/join', pathname);
  if (params && method === 'POST') {
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

  // ----------------------------------------------------------- submissions
  if (pathname === '/api/clipper/submissions' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT s.id, s.permalink, s.views, s.earning, s.status, s.sync_error, s.created_at, s.last_synced_at,
              c.name AS campaign_name, c.id AS campaign_id
       FROM submissions s JOIN campaigns c ON c.id = s.campaign_id
       WHERE s.clipper_id = ? ORDER BY s.created_at DESC`
    ).bind(clipperId).all();
    return json({ submissions: results || [] });
  }

  if (pathname === '/api/clipper/submissions' && method === 'POST') {
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

    await env.DB.prepare(
      `INSERT INTO submissions (clipper_id, campaign_id, account_id, ig_media_id, permalink, views, earning, status, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 'active', ?)`
    ).bind(clipperId, campaign_id, account.id, media.id, media.permalink, now()).run();

    return json({ ok: true, message: 'Video submitted — views start tracking on the next sync' }, 201);
  }

  // ------------------------------------------------------------ directory
  // Performance is shared between clippers; payment status deliberately is not.
  if (pathname === '/api/clipper/directory' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT cl.id, cl.username, cl.display_name,
              COUNT(DISTINCT s.id) AS videos,
              COALESCE(SUM(s.views),0) AS views,
              COALESCE(SUM(s.earning),0) AS earned
       FROM clippers cl
       LEFT JOIN submissions s ON s.clipper_id = cl.id AND s.status = 'active'
       WHERE cl.status = 'active'
       GROUP BY cl.id
       ORDER BY earned DESC, views DESC`
    ).all();

    const { results: rows } = await env.DB.prepare(
      `SELECT p.clipper_id, c.name AS campaign_name, p.status,
              COUNT(s.id) AS videos,
              COALESCE(SUM(s.views),0) AS views,
              COALESCE(SUM(s.earning),0) AS earned
       FROM participations p
       JOIN campaigns c ON c.id = p.campaign_id
       LEFT JOIN submissions s ON s.clipper_id = p.clipper_id AND s.campaign_id = p.campaign_id AND s.status = 'active'
       GROUP BY p.id`
    ).all();

    const byClipper = new Map();
    for (const r of rows || []) {
      if (!byClipper.has(r.clipper_id)) byClipper.set(r.clipper_id, []);
      byClipper.get(r.clipper_id).push({
        campaign_name: r.campaign_name, status: r.status,
        videos: r.videos, views: r.views, earned: r.earned
      });
    }

    return json({
      clippers: (results || []).map(c => ({
        id: c.id,
        display_name: c.display_name || c.username,
        username: c.username,
        videos: c.videos,
        views: c.views,
        earned: c.earned,
        is_me: c.id === clipperId,
        campaigns: byClipper.get(c.id) || []
      }))
    });
  }

  return null;
}
