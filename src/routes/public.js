import { json, matchPath, err } from '../http.js';
import { publicCampaign, campaignSpend } from '../db.js';
import { getSession } from '../auth.js';

// Only the campaign list is genuinely public -- the homepage renders its
// campaign tiles from it and it contains no clipper data. Everything that
// names a clipper or exposes earnings requires a session.
export async function handlePublic(request, env, url) {
  const { pathname } = url;
  if (request.method !== 'GET') return null;

  if (pathname === '/api/public/campaigns') {
    const { results } = await env.DB.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all();
    const out = [];
    for (const c of results || []) {
      const spent = await campaignSpend(env.DB, c.id);
      const parts = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM participations WHERE campaign_id = ? AND status = 'active'").bind(c.id).first();
      out.push({ ...publicCampaign(c, spent), participants: parts.n });
    }
    return json({ campaigns: out });
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
              COUNT(s.id) AS video_count,
              COALESCE(SUM(s.views),0) AS total_views,
              COALESCE(SUM(s.earning),0) AS total_earnings
       FROM clippers cl
       JOIN submissions s ON s.clipper_id = cl.id AND s.status = 'active'
       WHERE cl.status = 'active'
       GROUP BY cl.id
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
