import { now } from './db.js';

// Video quality review (migration 023). Shared by admin.js and
// moderator.js, since both an admin and a moderator can review a video --
// duplicating this SQL in two route files would fight the codebase's own
// pattern of shared helpers (db.js, earnings.js, payouts.js all exist for
// exactly this reason).
//
// Nothing in this file ever selects or writes submissions.earning,
// locked_at, locked_earning, lock_reason or payment_id. A review is a
// verdict in a separate table joined by submission_id -- it cannot affect
// what a clip is worth or whether it's paid, by construction.

const VERDICTS = ['tick', 'cross', 'skip'];

/** Day-bucketed unreviewed queue, today first, backlog falling away below it. Nothing here ever expires. */
export async function reviewQueue(db) {
  const { results } = await db.prepare(
    `SELECT s.id, s.permalink, s.platform, s.views, s.posted_at, s.created_at,
            s.thumbnail_key, s.thumbnail_url,
            date(COALESCE(s.posted_at, s.created_at) / 1000, 'unixepoch') AS day,
            cl.username AS clipper_username, cl.display_name AS clipper_display_name,
            c.name AS campaign_name, a.username AS account_username
     FROM submissions s
     JOIN clippers cl ON cl.id = s.clipper_id
     JOIN campaigns c ON c.id = s.campaign_id
     LEFT JOIN social_accounts a ON a.id = s.account_id
     LEFT JOIN submission_reviews sr ON sr.submission_id = s.id
     WHERE sr.id IS NULL
     ORDER BY day DESC, s.created_at ASC`
  ).all();
  const byDay = new Map();
  for (const r of results || []) {
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day).push({
      id: r.id, permalink: r.permalink, platform: r.platform || 'instagram', views: r.views,
      posted_at: r.posted_at, created_at: r.created_at,
      has_thumb: !!(r.thumbnail_key || r.thumbnail_url), thumb: `/api/media/thumb/${r.id}`,
      clipper_username: r.clipper_username, clipper_display_name: r.clipper_display_name || r.clipper_username,
      campaign_name: r.campaign_name, account_username: r.account_username
    });
  }
  return [...byDay.entries()].map(([date, items]) => ({ date, items }));
}

/** The Reviewed panel: most-recent first, still tagged with the video's original day. */
export async function reviewedList(db, { limit = 100 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const { results } = await db.prepare(
    `SELECT sr.verdict, sr.feedback, sr.reviewer_type, sr.reviewer_name, sr.reviewed_at,
            s.id AS submission_id, s.permalink, s.platform, s.views, s.posted_at, s.created_at,
            s.thumbnail_key, s.thumbnail_url,
            date(COALESCE(s.posted_at, s.created_at) / 1000, 'unixepoch') AS day,
            cl.username AS clipper_username, c.name AS campaign_name
     FROM submission_reviews sr
     JOIN submissions s ON s.id = sr.submission_id
     JOIN clippers cl ON cl.id = s.clipper_id
     JOIN campaigns c ON c.id = s.campaign_id
     ORDER BY sr.reviewed_at DESC LIMIT ?`
  ).bind(capped).all();
  return (results || []).map(r => ({
    ...r,
    has_thumb: !!(r.thumbnail_key || r.thumbnail_url),
    thumb: `/api/media/thumb/${r.submission_id}`
  }));
}

/** Live counters for the queue header: everyone's today-total, and this reviewer's own. */
export async function reviewCountsToday(db, { reviewerType, reviewerId = null }) {
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const sinceMs = since.getTime();
  const total = await db.prepare('SELECT COUNT(*) AS n FROM submission_reviews WHERE reviewed_at >= ?')
    .bind(sinceMs).first();
  const mine = reviewerType === 'admin'
    ? await db.prepare("SELECT COUNT(*) AS n FROM submission_reviews WHERE reviewed_at >= ? AND reviewer_type='admin'")
        .bind(sinceMs).first()
    : await db.prepare(
        "SELECT COUNT(*) AS n FROM submission_reviews WHERE reviewed_at >= ? AND reviewer_type='moderator' AND reviewer_id = ?"
      ).bind(sinceMs, reviewerId).first();
  return { total_today: total.n, mine_today: mine.n };
}

/** Inserts one verdict. A submission can only ever be reviewed once (UNIQUE submission_id). */
export async function submitReview(db, { submissionId, verdict, feedback, reviewerType, reviewerId, reviewerName }) {
  if (!VERDICTS.includes(verdict)) {
    return { error: `'${verdict}' is not a valid verdict. Accepted: ${VERDICTS.join(', ')}.`, status: 400 };
  }
  // Required for all three verdicts, including Skip -- a reviewer says why a
  // video is being marked "already verified elsewhere" just as much as why
  // one is good or bad, so there is always a real reason on record.
  if (!feedback || !String(feedback).trim()) {
    return { error: 'Feedback is required before you can tick, cross, or skip.', status: 400 };
  }
  const sub = await db.prepare('SELECT id FROM submissions WHERE id = ?').bind(submissionId).first();
  if (!sub) return { error: 'Submission not found', status: 404 };
  try {
    const res = await db.prepare(
      `INSERT INTO submission_reviews (submission_id, verdict, feedback, reviewer_type, reviewer_id, reviewer_name, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(submissionId, verdict, String(feedback).trim(), reviewerType, reviewerId, reviewerName, now()).run();
    return { id: res.meta.last_row_id };
  } catch (e) {
    if (/UNIQUE constraint/i.test(e.message || '')) {
      return { error: 'This video has already been reviewed.', status: 409 };
    }
    throw e;
  }
}

/** Lifetime tick/cross/skip for one clipper. Skip is excluded from the quality ratio. */
export async function clipperQuality(db, clipperId) {
  const { results } = await db.prepare(
    `SELECT sr.verdict, COUNT(*) AS n FROM submission_reviews sr
     JOIN submissions s ON s.id = sr.submission_id
     WHERE s.clipper_id = ? GROUP BY sr.verdict`
  ).bind(clipperId).all();
  const counts = { tick: 0, cross: 0, skip: 0 };
  for (const r of results || []) counts[r.verdict] = r.n;
  const denom = counts.tick + counts.cross;
  return { ...counts, quality_pct: denom ? Math.round((counts.tick / denom) * 100) : null };
}

/** Per-moderator (+ a synthetic admin row) lifetime and today totals, for management + ranking views. */
export async function moderatorActivity(db) {
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const sinceMs = since.getTime();
  const { results: mods } = await db.prepare(
    'SELECT id, username, display_name, status FROM moderators ORDER BY created_at ASC'
  ).all();
  const rows = [];
  for (const m of mods || []) {
    const lifetime = await db.prepare(
      "SELECT verdict, COUNT(*) AS n FROM submission_reviews WHERE reviewer_type='moderator' AND reviewer_id = ? GROUP BY verdict"
    ).bind(m.id).all();
    const today = await db.prepare(
      "SELECT COUNT(*) AS n FROM submission_reviews WHERE reviewer_type='moderator' AND reviewer_id = ? AND reviewed_at >= ?"
    ).bind(m.id, sinceMs).first();
    const counts = { tick: 0, cross: 0, skip: 0 };
    for (const r of lifetime.results || []) counts[r.verdict] = r.n;
    rows.push({
      id: m.id, username: m.username, display_name: m.display_name || m.username,
      status: m.status, ...counts, today: today.n
    });
  }
  const aLife = await db.prepare(
    "SELECT verdict, COUNT(*) AS n FROM submission_reviews WHERE reviewer_type='admin' GROUP BY verdict"
  ).all();
  const aToday = await db.prepare(
    "SELECT COUNT(*) AS n FROM submission_reviews WHERE reviewer_type='admin' AND reviewed_at >= ?"
  ).bind(sinceMs).first();
  const aCounts = { tick: 0, cross: 0, skip: 0 };
  for (const r of aLife.results || []) aCounts[r.verdict] = r.n;
  rows.push({ id: null, username: 'admin', display_name: 'Admin', status: 'active', ...aCounts, today: aToday.n });
  return rows;
}
