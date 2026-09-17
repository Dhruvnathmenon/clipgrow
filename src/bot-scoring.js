// Orchestrates src/bot-correlation.js (primary) and src/bot-detection.js
// (secondary) into the informational columns added by migration 043.
// Runs piggybacked on the existing refresh-job completion hook
// (src/worker.js's `onFinish`, shared by the 6-hourly cron, an admin's
// manual full refresh, and single-account resyncs) -- no new cron, no
// new infrastructure, matching the founder-approved plan.
//
// Writes ONLY bot_score / bot_score_reason / bot_correlation_cluster_id /
// bot_scored_at. Never earning, status, or any lock field -- this is
// display metadata for the None/Low/Medium/High badge
// (src/routes/admin.js, src/routes/moderator.js, admin.html,
// moderator.html), not a decision.
import { findCorrelatedClusters, CORRELATION_SCORE } from './bot-correlation.js';
import { scoreSubmission, computeClipperBaseline } from './bot-detection.js';

// How far back to look for view-growth events when scoring -- long
// enough to catch a slow-building pattern, short enough that this stays
// a small, bounded query regardless of how long ClipGrow has been
// running. Deliberately re-run on every call rather than tracking "what
// changed since last time" -- at ClipGrow's real scale this is cheap,
// and re-deriving from scratch means a clip's badge can never drift from
// what the data actually says.
const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

export async function scoreRecentSubmissions(db, { now = Date.now() } = {}) {
  const since = now - LOOKBACK_MS;

  // Every active, unlocked submission with at least one real view-growth
  // event in the window. A locked/paid clip stopped syncing (and so
  // stopped generating new snapshots) the moment it was settled, so
  // there is nothing new to score for one anyway.
  const { results: subs } = await db.prepare(
    `SELECT DISTINCT s.id, s.clipper_id, s.campaign_id, s.views, s.likes, s.comments, s.earning, s.platform
       FROM submissions s
       JOIN submission_view_snapshots v ON v.submission_id = s.id
      WHERE v.recorded_at >= ? AND s.status = 'active' AND s.locked_at IS NULL`
  ).bind(since).all();
  if (!subs || !subs.length) return { scored: 0, clusters: 0 };

  const { results: snapshotRows } = await db.prepare(
    `SELECT submission_id, views, likes, comments, recorded_at FROM submission_view_snapshots
      WHERE recorded_at >= ? ORDER BY submission_id ASC, recorded_at ASC`
  ).bind(since).all();

  const snapshotsBySubmission = new Map();
  for (const row of snapshotRows || []) {
    if (!snapshotsBySubmission.has(row.submission_id)) snapshotsBySubmission.set(row.submission_id, []);
    snapshotsBySubmission.get(row.submission_id).push(row);
  }

  // Primary detector: cross-account timing correlation.
  const clusters = findCorrelatedClusters(
    subs.map(s => ({ submissionId: s.id, clipperId: s.clipper_id, snapshots: snapshotsBySubmission.get(s.id) || [] }))
  );

  // Per-clipper baseline for the secondary engagement-ratio heuristic --
  // computed once per clipper across ALL their active submissions with a
  // meaningful view count (not just the ones in the recent window), so a
  // clipper with one slow-growing recent clip still has a real baseline
  // to compare it against.
  const { results: allActive } = await db.prepare(
    `SELECT clipper_id, views, likes, comments FROM submissions WHERE status = 'active'`
  ).all();
  const byClipper = new Map();
  for (const row of allActive || []) {
    if (!byClipper.has(row.clipper_id)) byClipper.set(row.clipper_id, []);
    byClipper.get(row.clipper_id).push(row);
  }
  const baselineByClipper = new Map();
  for (const [clipperId, rows] of byClipper) baselineByClipper.set(clipperId, computeClipperBaseline(rows));

  const campaignCache = new Map();
  async function getCampaign(campaignId) {
    if (!campaignCache.has(campaignId)) {
      campaignCache.set(campaignId, await db.prepare('SELECT * FROM campaigns WHERE id = ?').bind(campaignId).first());
    }
    return campaignCache.get(campaignId);
  }

  let scored = 0;
  for (const s of subs) {
    const clusterId = clusters.get(s.id) || null;
    const campaign = await getCampaign(s.campaign_id);
    const secondary = scoreSubmission({
      submission: s,
      snapshots: snapshotsBySubmission.get(s.id) || [],
      clipperBaseline: baselineByClipper.get(s.clipper_id) || null,
      campaign
    });

    // A flagged correlation cluster is trusted enough to reach 'high' on
    // its own; secondary heuristics alone are capped below it (Part 2 of
    // the plan) -- max(), never sum, so the two signals cannot stack
    // into a false high-confidence reading.
    const score = clusterId ? Math.max(CORRELATION_SCORE, secondary.score) : secondary.score;
    const reasons = clusterId
      ? [`synchronized with other clippers' clips (cluster #${clusterId})`, ...secondary.reasons]
      : secondary.reasons;

    const res = await db.prepare(
      `UPDATE submissions SET bot_score = ?, bot_score_reason = ?, bot_correlation_cluster_id = ?, bot_scored_at = ?
        WHERE id = ? AND locked_at IS NULL`
    ).bind(score, reasons.length ? reasons.join('; ') : null, clusterId, now, s.id).run();
    if (res.meta.changes) scored++;
  }

  return { scored, clusters: new Set(clusters.values()).size };
}
