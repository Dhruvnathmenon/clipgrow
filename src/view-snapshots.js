// Shared by src/earnings.js (syncAccountClips) and src/refresh-jobs.js
// (runViews) -- the two places a freshly-synced view count lands on a
// submission. Delta-only: a sync that reads back the same view count as
// last time writes nothing here, so this table's size tracks real
// view-growth events, not sync frequency. This is what makes
// src/bot-correlation.js's cross-account timing-correlation signal (and
// src/bot-detection.js's changepoint heuristic) possible at all -- there
// is no other history anywhere in the schema, since submissions.views is
// blind-overwritten on every sync.
//
// Purely additive bookkeeping: never touches submissions.earning, status,
// or any lock field, and is never itself guarded by locked_at -- a locked
// clip simply stops syncing upstream (the guarded UPDATE that feeds this
// never fires for one), so this is naturally never called for a paid clip.
export async function recordViewSnapshot(db, { submissionId, clipperId, views, likes = null, comments = null, recordedAt = Date.now() }) {
  const last = await db.prepare(
    'SELECT views FROM submission_view_snapshots WHERE submission_id = ? ORDER BY recorded_at DESC LIMIT 1'
  ).bind(submissionId).first();
  if (last && last.views === views) return; // unchanged -- nothing to record

  await db.prepare(
    `INSERT INTO submission_view_snapshots (submission_id, clipper_id, views, likes, comments, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(submissionId, clipperId, views, likes, comments, recordedAt).run();
}
