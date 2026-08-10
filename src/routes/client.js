import { json, err, readJson, matchPath } from '../http.js';
import { createSessionCookie, requireClient, verifyPassword, clearCookieHeader } from '../auth.js';
import { getClipperByUsername, normalizeUsername, campaignSpend, publicCampaign } from '../db.js';
import { clipState, clipStateMessage } from '../clipstate.js';
import { platformLabel, campaignPlatforms } from '../platforms.js';

// Read-only brand/client portal.
//
// Every route here is GET-only by design: a client can look at their own
// campaign and nothing else. Two boundaries are enforced on every single
// request rather than once at login, so a guessed or stale campaign id can
// never leak another brand's data:
//
//   1. scope   -- the campaign must be granted to this client in client_campaigns
//   2. secrecy -- no clipper payment state ever crosses this boundary
//
// The client sees budget and spend (they are funding it) but never what an
// individual clipper is owed or has been paid.

/** Campaign ids this client is allowed to see. */
async function grantedCampaignIds(db, clientId) {
  const { results } = await db.prepare(
    'SELECT campaign_id FROM client_campaigns WHERE client_id = ?'
  ).bind(clientId).all();
  return new Set((results || []).map(r => r.campaign_id));
}

export async function handleClient(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/client/login' && method === 'POST') {
    const { username, password } = await readJson(request);
    if (!username || !password) return err('Enter your username and password');
    const client = await env.DB.prepare('SELECT * FROM clients WHERE username = ? COLLATE NOCASE')
      .bind(normalizeUsername(username)).first();
    if (!client) return err('Invalid username or password', 401);
    const valid = await verifyPassword(password, client.password_hash, client.password_salt);
    if (!valid) return err('Invalid username or password', 401);
    if (client.status !== 'active') return err('This client account has been disabled. Contact ClipGrow.', 403);
    const cookie = await createSessionCookie('client', client.id, env.SESSION_SECRET);
    return json({ ok: true }, 200, { 'Set-Cookie': cookie });
  }

  if (pathname === '/api/client/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookieHeader('cg_session') });
  }

  if (!pathname.startsWith('/api/client/')) return null;

  // Observer only: nothing here may ever mutate state.
  if (method !== 'GET') return err('This is a read-only account', 405);

  const session = await requireClient(request, env);
  if (!session) return err('Unauthorized', 401);
  const clientId = Number(session.sub);

  const me = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
  if (!me) return json({ error: 'Account no longer exists' }, 401, { 'Set-Cookie': clearCookieHeader('cg_session') });
  if (me.status !== 'active') return err('This client account has been disabled. Contact ClipGrow.', 403);

  if (pathname === '/api/client/me' && method === 'GET') {
    return json({
      client: {
        id: me.id, username: me.username,
        company_name: me.company_name || me.username,
        contact_name: me.contact_name || ''
      }
    });
  }

  // ------------------------------------------------------------- campaigns
  if (pathname === '/api/client/campaigns' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT c.* FROM client_campaigns cc JOIN campaigns c ON c.id = cc.campaign_id
       WHERE cc.client_id = ? ORDER BY c.created_at DESC`
    ).bind(clientId).all();

    const out = [];
    for (const c of results || []) {
      const spent = await campaignSpend(env.DB, c.id);
      const stats = await env.DB.prepare(
        `SELECT COUNT(*) AS clips,
                COALESCE(SUM(views),0) AS views,
                COUNT(DISTINCT clipper_id) AS clippers
         FROM submissions WHERE campaign_id = ? AND status = 'active'`
      ).bind(c.id).first();
      const pub = publicCampaign(c, spent);
      out.push({
        id: pub.id, name: pub.name, slug: pub.slug, description: pub.description,
        cpm: pub.cpm, min_views: pub.min_views, status: pub.status,
        budget: pub.budget, spent: pub.spent, remaining: pub.remaining,
        created_at: pub.created_at,
        blueprint: pub.blueprint,
        totals: { clips: stats.clips || 0, views: stats.views || 0, clippers: stats.clippers || 0 }
      });
    }
    return json({ campaigns: out });
  }

  // Per-campaign detail: who is clipping, what they posted, how it performed.
  const params = matchPath('/api/client/campaigns/:id', pathname);
  if (params && method === 'GET') {
    const allowed = await grantedCampaignIds(env.DB, clientId);
    // Checked on every request, not just at login, so revoking a grant in the
    // admin panel takes effect immediately even on an open session.
    if (!allowed.has(Number(params.id))) return err('Not found', 404);

    const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(params.id).first();
    if (!campaign) return err('Not found', 404);

    const { results: clipRows } = await env.DB.prepare(
      `SELECT s.id, s.permalink, s.views, s.status, s.sync_error, s.source, s.platform, s.eligible,
              s.created_at, s.posted_at, s.last_ok_sync_at, s.locked_at, s.lock_reason,
              s.thumbnail_key, s.thumbnail_url,
              cl.id AS clipper_id, cl.display_name, cl.username,
              a.username AS account_username
       FROM submissions s
       JOIN clippers cl ON cl.id = s.clipper_id
       LEFT JOIN social_accounts a ON a.id = s.account_id
       WHERE s.campaign_id = ?
       ORDER BY s.views DESC, COALESCE(s.posted_at, s.created_at) DESC`
    ).bind(params.id).all();

    const minViews = campaign.min_views || 0;

    // Deliberately omits earning, locked_earning and every payment field: what
    // a clipper is owed or has been paid is not the client's business.
    const clips = (clipRows || []).map(r => {
      const state = clipState({ ...r, min_views: minViews });
      return {
        id: r.id,
        clipper_id: r.clipper_id,
        clipper_name: r.display_name || r.username,
        account_username: r.account_username,
        platform: r.platform || 'instagram',
        platform_label: platformLabel(r.platform || 'instagram'),
        permalink: r.permalink,
        views: r.views,
        state,
        state_message: clipStateMessage(state, r),
        below_min: minViews > 0 && r.views < minViews,
        has_thumb: !!(r.thumbnail_key || r.thumbnail_url),
        posted_at: r.posted_at,
        synced_at: r.created_at,
        last_ok_sync_at: r.last_ok_sync_at,
        source: r.source || 'manual'
      };
    });

    // Per-clipper roll-up, again views only.
    const byClipper = new Map();
    for (const c of clips) {
      const entry = byClipper.get(c.clipper_id) ||
        { clipper_id: c.clipper_id, clipper_name: c.clipper_name, account_username: c.account_username, clips: 0, views: 0 };
      entry.clips++;
      entry.views += c.views || 0;
      byClipper.set(c.clipper_id, entry);
    }
    const clippers = [...byClipper.values()].sort((a, b) => b.views - a.views);

    const spent = await campaignSpend(env.DB, campaign.id);
    const pub = publicCampaign(campaign, spent);

    return json({
      campaign: {
        id: pub.id, name: pub.name, description: pub.description,
        cpm: pub.cpm, min_views: pub.min_views, status: pub.status,
        budget: pub.budget, spent: pub.spent, remaining: pub.remaining,
        created_at: pub.created_at, blueprint: pub.blueprint
      },
      by_platform: Object.values(clips.reduce((acc, c) => {
        if (!acc[c.platform]) acc[c.platform] = { platform: c.platform, label: c.platform_label, clips: 0, views: 0 };
        acc[c.platform].clips++;
        acc[c.platform].views += c.views || 0;
        return acc;
      }, {})),
      totals: {
        clips: clips.length,
        views: clips.reduce((n, c) => n + (c.views || 0), 0),
        clippers: clippers.length,
        clips_below_min: clips.filter(c => c.below_min).length
      },
      clippers,
      clips
    });
  }

  return null;
}
