import { json, matchPath, err } from '../http.js';
import { publicCampaign, campaignSpend, spendExpr } from '../db.js';
import { getSession } from '../auth.js';

// Only the campaign list is genuinely public -- the homepage renders its
// campaign tiles from it and it contains no clipper data. Everything that
// names a clipper or exposes earnings requires a session.

// The subset of a campaign safe to hand an anonymous caller: exactly the
// fields the marketing site's campaign tiles render, and nothing else.
//
// publicCampaign() also carries budget, spent, remaining and the full
// blueprint (the objective, the CTA script, the hashtags, the client's own
// handle). Those are internal -- an unauthenticated /api/public/campaigns was
// putting the agency's deal sizes and client list in every visitor's network
// tab. A logged-in clipper or client (the /tracker page) still gets the
// fuller shape it displays.
function publicListItem(c) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    slug: c.slug,
    status: c.status,
    cpm: c.cpm,
    min_views: c.min_views,
    allowed_platforms: c.allowed_platforms,
    created_at: c.created_at,
    // Only the per-clip ceiling -- the one blueprint figure a clipper is
    // shown before deciding to join.
    blueprint:
      c.blueprint && typeof c.blueprint.max_payout === 'number'
        ? { max_payout: c.blueprint.max_payout }
        : {}
  };
}

export async function handlePublic(request, env, url) {
  const { pathname } = url;
  if (request.method !== 'GET') return null;

  if (pathname === '/api/public/campaigns') {
    const session = await getSession(request, env);
    const { results } = await env.DB.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all();
    const out = [];
    for (const c of results || []) {
      const spent = await campaignSpend(env.DB, c.id);
      const parts = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM participations WHERE campaign_id = ? AND status = 'active'").bind(c.id).first();
      const full = { ...publicCampaign(c, spent), participants: parts.n };
      out.push(session ? full : publicListItem(full));
    }
    return json({ campaigns: out });
  }

  // Site-wide cumulative totals for the marketing page.
  //
  // Public on purpose, and safe to be: it names nobody and exposes no
  // per-campaign or per-clipper figure. It is the aggregate we already
  // advertise, served from the source of truth instead of being retyped into
  // copy and going stale.
  //
  // Rolled to the most recent Sunday rather than being live-to-the-second.
  // Views and payouts have to move together -- a views number that crept up
  // mid-week would imply money we had not yet sent, since payouts run Sunday.
  // The Cache-Control keeps it off the database for an hour at the edge; the
  // figure only changes weekly, so an hour of staleness costs nothing.
  if (pathname === '/api/public/stats') {
    const row = await env.DB.prepare(
      `SELECT
         (SELECT COALESCE(SUM(views), 0) FROM submissions WHERE status = 'active')      AS total_views,
         (SELECT COUNT(*)               FROM submissions WHERE status = 'active')       AS total_clips,
         (SELECT COALESCE(SUM(amount),0) FROM payments)                                 AS total_paid,
         (SELECT COUNT(DISTINCT clipper_id) FROM payments)                              AS clippers_paid,
         (SELECT COUNT(*)               FROM campaigns)                                 AS campaigns`
    ).first();

    // Midnight UTC on the most recent Sunday.
    const now = new Date();
    const sunday = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - now.getUTCDay()
    );

    return json(
      {
        total_views: row?.total_views ?? 0,
        total_clips: row?.total_clips ?? 0,
        total_paid: row?.total_paid ?? 0,
        clippers_paid: row?.clippers_paid ?? 0,
        campaigns: row?.campaigns ?? 0,
        as_of: sunday
      },
      200,
      { 'Cache-Control': 'public, max-age=3600' }
    );
  }

  const needsSession = pathname === '/api/public/leaderboard'
    || pathname === '/api/public/submissions'
    || matchPath('/api/public/campaigns/:id', pathname);
  if (!needsSession) return null;

  const session = await getSession(request, env);
  if (!session) return err('Unauthorized', 401);

  if (pathname === '/api/public/leaderboard') {
    const { results } = await env.DB.prepare(
      `SELECT cl.id, cl.username, cl.display_name,
              COUNT(CASE WHEN s.status = 'active' THEN 1 END) AS video_count,
              COALESCE(SUM(CASE WHEN s.status = 'active' THEN s.views ELSE 0 END),0) AS total_views,
              ${spendExpr('s')} AS total_earnings
       FROM clippers cl
       JOIN submissions s ON s.clipper_id = cl.id
       WHERE cl.status = 'active'
       GROUP BY cl.id
       -- Dropping the status filter from the JOIN is what lets a paid-then-
       -- disqualified clip still count its settled money. HAVING keeps a
       -- clipper whose only clips are disqualified and unpaid off the public
       -- board, which the old JOIN filter did implicitly.
       HAVING video_count > 0 OR total_earnings > 0
       ORDER BY total_earnings DESC, total_views DESC`
    ).all();
    return json({ leaderboard: results || [] });
  }

  if (pathname === '/api/public/submissions') {
    const { results } = await env.DB.prepare(
      `SELECT cl.username, cl.display_name, c.name AS campaign_name, s.permalink, s.views, s.earning, s.created_at
       FROM submissions s
       JOIN clippers cl ON cl.id = s.clipper_id
       JOIN campaigns c ON c.id = s.campaign_id
       WHERE s.status = 'active'
       ORDER BY s.views DESC LIMIT 200`
    ).all();
    return json({ submissions: results || [] });
  }

  const params = matchPath('/api/public/campaigns/:id', pathname);
  if (params) {
    const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(params.id).first();
    if (!campaign) return err('Not found', 404);
    const { results: submissions } = await env.DB.prepare(
      `SELECT cl.username, cl.display_name, s.permalink, s.views, s.earning, s.created_at
       FROM submissions s JOIN clippers cl ON cl.id = s.clipper_id
       WHERE s.campaign_id = ? AND s.status = 'active' ORDER BY s.views DESC`
    ).bind(params.id).all();
    return json({
      campaign: publicCampaign(campaign, await campaignSpend(env.DB, params.id)),
      submissions: submissions || []
    });
  }

  return null;
}
