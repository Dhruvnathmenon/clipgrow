import { json, err, readJson, matchPath } from '../http.js';
import {
  createSessionCookie, requireModerator, verifyPassword, hashPassword, clearCookieHeader
} from '../auth.js';
import {
  now, getModeratorByUsername, getModeratorById,
  publicClipper, publicAccount
} from '../db.js';
import {
  reviewQueue, reviewedList, reviewCountsToday, submitReview, clipperQuality, allClipperQuality, EMPTY_QUALITY
} from '../reviews.js';
import { applicationQueue, reviewApplication, applicationHistory } from '../applications.js';
import { logAction } from '../audit.js';

// Moderator staff role (migration 023) -- deliberately narrow. A moderator
// can: leave a private note on a clipper, review videos (tick/cross/skip),
// see the roster and each clipper's connected accounts by campaign
// (read-only, no money), and change their own password. Nothing here can
// create a clipper login (admin-only, on purpose -- see the removed POST
// /api/moderator/clippers below), trigger a refresh (also admin-only now --
// see the removed resync route below), kick, pause, approve/reject an
// access request, disconnect an account, edit a campaign, or touch a
// payment -- those routes simply do not exist in this file, which is the
// entire enforcement of the boundary.
export async function handleModerator(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/moderator/login' && method === 'POST') {
    const { username, password } = await readJson(request);
    if (!username || !password) return err('Enter your username and password');
    const mod = await getModeratorByUsername(env.DB, username);
    if (!mod || mod.status !== 'active') return err('Invalid username or password', 401);
    const valid = await verifyPassword(password, mod.password_hash, mod.password_salt);
    if (!valid) return err('Invalid username or password', 401);
    const cookie = await createSessionCookie('moderator', mod.id, env.SESSION_SECRET);
    return json({ ok: true }, 200, { 'Set-Cookie': cookie });
  }

  if (pathname === '/api/moderator/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookieHeader('cg_session') });
  }

  if (!pathname.startsWith('/api/moderator/')) return null;

  const session = await requireModerator(request, env);
  if (!session) return err('Unauthorized', 401);
  const moderatorId = Number(session.sub);

  const me = await getModeratorById(env.DB, moderatorId);
  // A disabled moderator is fully cut off -- unlike a disabled clipper (who
  // keeps read-only access to their own earnings), there is nothing a
  // deactivated moderator should still be able to see or do here.
  if (!me || me.status !== 'active') {
    return json({ error: 'Account no longer exists' }, 401, { 'Set-Cookie': clearCookieHeader('cg_session') });
  }
  const staffName = me.display_name || me.username;

  // ------------------------------------------------------------- profile
  if (pathname === '/api/moderator/me' && method === 'GET') {
    const { results } = await env.DB.prepare(
      "SELECT verdict, COUNT(*) AS n FROM submission_reviews WHERE reviewer_type='moderator' AND reviewer_id = ? GROUP BY verdict"
    ).bind(moderatorId).all();
    const counts = { tick: 0, cross: 0, skip: 0 };
    for (const r of results || []) counts[r.verdict] = r.n;
    return json({
      moderator: { id: me.id, username: me.username, display_name: staffName, status: me.status },
      lifetime: counts
    });
  }

  if (pathname === '/api/moderator/me/password' && method === 'PATCH') {
    const { currentPassword, newPassword } = await readJson(request);
    if (!currentPassword || !newPassword) return err('Enter your current and new password');
    const valid = await verifyPassword(currentPassword, me.password_hash, me.password_salt);
    // 403, not 401 -- this page's api() helper (like dashboard.html's) treats
    // any 401 as "session expired" and force-redirects to the login screen.
    if (!valid) return err('Current password is incorrect', 403);
    if (String(newPassword).length < 6) return err('New password must be at least 6 characters');
    const { hash, salt } = await hashPassword(newPassword);
    await env.DB.prepare('UPDATE moderators SET password_hash = ?, password_salt = ? WHERE id = ?')
      .bind(hash, salt, moderatorId).run();
    return json({ ok: true });
  }

  // ------------------------------------------------------------ clippers
  //
  // Creating a clipper login is admin-only now (moderators used to be able
  // to, mirroring admin.js's POST /api/admin/clippers -- removed on request
  // so only the admin account can create logins; the rest of what a
  // moderator does -- roster, notes, review -- is unchanged).

  // Roster, no financial fields -- same shape as admin.js's GET
  // /api/admin/clippers, minus clipperFinancials().
  if (pathname === '/api/moderator/clippers' && method === 'GET') {
    const { results } = await env.DB.prepare(
      "SELECT * FROM clippers WHERE status != 'deleted' ORDER BY created_at DESC"
    ).all();
    // Whole-roster counts in three queries, not three per row -- the per-row
    // loop was the source of the intermittent D1 "internal error" here.
    const [quality, acctRows, partRows] = await Promise.all([
      allClipperQuality(env.DB),
      env.DB.prepare('SELECT clipper_id, COUNT(*) AS n FROM social_accounts GROUP BY clipper_id').all(),
      env.DB.prepare("SELECT clipper_id, COUNT(*) AS n FROM participations WHERE status != 'kicked' GROUP BY clipper_id").all()
    ]);
    const accByClipper = new Map((acctRows.results || []).map(r => [r.clipper_id, r.n]));
    const partByClipper = new Map((partRows.results || []).map(r => [r.clipper_id, r.n]));
    const out = (results || []).map(c => ({
      ...publicClipper(c),
      accounts: accByClipper.get(c.id) || 0,
      campaigns: partByClipper.get(c.id) || 0,
      quality: quality.get(c.id) || EMPTY_QUALITY
    }));
    return json({ clippers: out });
  }

  let params = matchPath('/api/moderator/clippers/:id', pathname);
  if (params && method === 'GET') {
    const clipper = await env.DB.prepare("SELECT * FROM clippers WHERE id = ? AND status != 'deleted'")
      .bind(params.id).first();
    if (!clipper) return err('Not found', 404);
    // Same campaign-linkage query shipped in admin.js's clipper detail --
    // which campaign each connected account actually drives right now.
    const { results: accounts } = await env.DB.prepare(
      `SELECT a.*,
         (SELECT c.name FROM participation_accounts pa
            JOIN participations p ON p.id = pa.participation_id
            JOIN campaigns c ON c.id = p.campaign_id
            WHERE pa.account_id = a.id LIMIT 1) AS campaign_name
       FROM social_accounts a WHERE a.clipper_id = ?`
    ).bind(params.id).all();
    const { results: parts } = await env.DB.prepare(
      `SELECT p.status, c.name AS campaign_name FROM participations p
       JOIN campaigns c ON c.id = p.campaign_id WHERE p.clipper_id = ?`
    ).bind(params.id).all();
    const { results: notes } = await env.DB.prepare(
      'SELECT * FROM clipper_notes WHERE clipper_id = ? ORDER BY created_at DESC'
    ).bind(params.id).all();
    return json({
      clipper: publicClipper(clipper),
      quality: await clipperQuality(env.DB, params.id),
      accounts: (accounts || []).map(a => ({ ...publicAccount(a), campaign_name: a.campaign_name || null })),
      participations: parts || [],
      notes: notes || []
    });
  }

  params = matchPath('/api/moderator/clippers/:id/notes', pathname);
  if (params && method === 'POST') {
    const { note } = await readJson(request);
    if (!note || !String(note).trim()) return err('Write a note first');
    const clipper = await env.DB.prepare("SELECT id FROM clippers WHERE id = ? AND status != 'deleted'")
      .bind(params.id).first();
    if (!clipper) return err('Not found', 404);
    await env.DB.prepare(
      `INSERT INTO clipper_notes (clipper_id, note, author_type, author_id, author_name, created_at)
       VALUES (?, ?, 'moderator', ?, ?, ?)`
    ).bind(params.id, String(note).trim(), moderatorId, staffName, now()).run();
    return json({ ok: true });
  }

  // A moderator used to be able to trigger a tier-2 resync here. It is gone
  // along with the clipper's own per-clip button: with the cron running
  // hourly, a manual sweep cannot surface anything that is not already
  // minutes away, and every one of them spends from the same per-account
  // 200/hour Instagram ceiling the cron needs to keep that promise.
  // Triggering a refresh is now an admin-only action, kept for verification
  // and emergencies -- which is the whole reason the budget headroom exists.
  // A moderator who needs fresher numbers waits for the top of the hour, the
  // same as everyone else.

  // ------------------------------------------------ campaign applications
  //
  // Step 1 of the new two-step onboarding. Separate from the posted-clip
  // review queue below: that one judges live, monetising clips on a
  // connected account, this one judges a video from someone who has not
  // connected anything yet. Same reviewer, same "a verdict needs a reason"
  // rule, different subject -- so they are different queues rather than one
  // queue with a type column nobody can filter on reliably.
  if (pathname === '/api/moderator/applications' && method === 'GET') {
    return json({ applications: await applicationQueue(env.DB) });
  }

  params = matchPath('/api/moderator/applications/:id/history', pathname);
  if (params && method === 'GET') {
    const app = await env.DB.prepare(
      'SELECT clipper_id, campaign_id FROM campaign_applications WHERE id = ?'
    ).bind(params.id).first();
    if (!app) return err('Application not found', 404);
    // Previous attempts and the notes left on them -- a reviewer deciding a
    // second or third attempt needs to see what was already asked for.
    return json({ history: await applicationHistory(env.DB, app.clipper_id, app.campaign_id) });
  }

  params = matchPath('/api/moderator/applications/:id', pathname);
  if (params && method === 'POST') {
    const { verdict, note } = await readJson(request);
    const r = await reviewApplication(env.DB, Number(params.id), {
      verdict, note, reviewerType: 'moderator', reviewerId: moderatorId, reviewerName: staffName
    });
    if (r.error) return json({ error: r.error }, r.status || 400);
    await logAction(env.DB, {
      staffType: 'moderator', staffId: moderatorId, staffName,
      action: r.verdict === 'approved' ? 'application_approved' : 'application_rejected',
      targetType: 'application', targetId: Number(params.id),
      targetLabel: r.removed_from_campaign ? 'final attempt -- removed from campaign' : null
    });
    return json(r);
  }

  // -------------------------------------------------------- video review
  if (pathname === '/api/moderator/queue' && method === 'GET') {
    return json({
      days: await reviewQueue(env.DB),
      counts: await reviewCountsToday(env.DB, { reviewerType: 'moderator', reviewerId: moderatorId })
    });
  }

  if (pathname === '/api/moderator/reviewed' && method === 'GET') {
    return json({ reviews: await reviewedList(env.DB, { limit: Number(url.searchParams.get('limit')) || 100 }) });
  }

  if (pathname === '/api/moderator/reviews' && method === 'POST') {
    const { submission_id, verdict, feedback } = await readJson(request);
    const result = await submitReview(env.DB, {
      submissionId: Number(submission_id), verdict, feedback,
      reviewerType: 'moderator', reviewerId: moderatorId, reviewerName: staffName
    });
    if (result.error) return err(result.error, result.status || 400);
    return json({ ok: true, id: result.id });
  }

  return null;
}
