import { json, err, readJson, matchPath } from '../http.js';
import {
  createSessionCookie, requireModerator, verifyPassword, hashPassword, clearCookieHeader
} from '../auth.js';
import {
  now, normalizeUsername, defaultDisplayName, getModeratorByUsername, getModeratorById,
  publicClipper, publicAccount
} from '../db.js';
import { createRefreshJob, advanceJob, getJob, publicJob } from '../refresh-jobs.js';
import { reallocateAll } from '../earnings.js';
import {
  reviewQueue, reviewedList, reviewCountsToday, submitReview, clipperQuality, allClipperQuality, EMPTY_QUALITY
} from '../reviews.js';
import { logAction } from '../audit.js';

// Moderator staff role (migration 023) -- deliberately narrow. A moderator
// can: create clipper logins, trigger a resync for one clipper, leave a
// private note on a clipper, review videos (tick/cross/skip), see the
// roster and each clipper's connected accounts by campaign (read-only, no
// money), and change their own password. Nothing here can kick, pause,
// approve/reject an access request, disconnect an account, edit a
// campaign, or touch a payment -- those routes simply do not exist in
// this file, which is the entire enforcement of the boundary.
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
  // Create-clipper mirrors admin.js's own POST /api/admin/clippers exactly
  // (same validation, same hashing), plus attribution so the admin can
  // always see which moderator created a given login.
  if (pathname === '/api/moderator/clippers' && method === 'POST') {
    const { username, password } = await readJson(request);
    if (!username || !password) return err('Username and password are required');
    if (String(password).length < 6) return err('Password must be at least 6 characters');
    const clean = normalizeUsername(username);
    if (!clean) return err('Username cannot be blank');
    const existing = await env.DB
      .prepare('SELECT id FROM clippers WHERE username = ? COLLATE NOCASE').bind(clean).first();
    if (existing) return err('That username is already taken', 409);
    const { hash, salt } = await hashPassword(password);
    // Display name is always the username, capitalised -- the gold standard.
    const res = await env.DB.prepare(
      `INSERT INTO clippers (username, password_hash, password_salt, display_name, status, created_at, created_by_type, created_by_id, created_by_name)
       VALUES (?, ?, ?, ?, 'active', ?, 'moderator', ?, ?)`
    ).bind(clean, hash, salt, defaultDisplayName(clean), now(), moderatorId, staffName).run();
    await logAction(env.DB, {
      staffType: 'moderator', staffId: moderatorId, staffName, action: 'clipper_created',
      targetType: 'clipper', targetId: res.meta.last_row_id, targetLabel: clean
    });
    return json({ ok: true, id: res.meta.last_row_id, username: clean }, 201);
  }

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

  // Same tier-2 resync admin.js's "Refresh Now" uses, just attributed to
  // this moderator instead of 'admin' -- refresh_jobs.triggered_by is a
  // free-text column, so no schema change was needed for this.
  params = matchPath('/api/moderator/clippers/:id/refresh', pathname);
  if (params && method === 'POST') {
    const clipper = await env.DB.prepare("SELECT id, username FROM clippers WHERE id = ? AND status != 'deleted'")
      .bind(params.id).first();
    if (!clipper) return err('Clipper not found', 404);
    const created = await createRefreshJob(env.DB, {
      kind: 'clipper', clipperId: Number(params.id), triggeredBy: `moderator:${moderatorId}`, respectCooldown: false
    });
    if (created.error) return json({ error: created.error, job_id: created.job_id }, created.status || 409);
    const first = await advanceJob(env.DB, env, created.job_id, { onFinish: () => reallocateAll(env.DB) });
    await logAction(env.DB, {
      staffType: 'moderator', staffId: moderatorId, staffName, action: 'refresh_triggered',
      targetType: 'clipper', targetId: Number(params.id), targetLabel: clipper.username
    });
    return json({
      ok: true, job_id: created.job_id,
      job: publicJob(await getJob(env.DB, created.job_id)),
      first_chunk: { calls: first.calls, done: first.done }
    });
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
