// Secondary, single-clip risk signals -- supporting context only.
//
// Per the founder-approved bot-detection plan: no single-clip formula is
// reliable enough to carry a strong warning alone. Even academic
// researchers with full ground-truth visibility on a real, traced
// YouTube view-fraud operation concluded "we ultimately are unable to
// distinguish fake views from real organic ones" from view-side signals
// (Kuchhal & Li, "A View into YouTube View Fraud", ACM WWW 2022). The
// primary, high-confidence signal in this system is
// src/bot-correlation.js's cross-account timing correlation; everything
// in this file only adds color/reasons to a badge and is capped below
// the 'high' tier (SECONDARY_MAX_SCORE) so it can never manufacture a
// strong warning on its own.
//
// Mostly NOT absolute thresholds. YouTube's own published fix for "a
// video that's just quiet, not botted" is to compare retention only
// against videos of similar length, never a fixed number -- the
// equivalent here is comparing a clip against that SAME clipper's own
// baseline, never a fixed percentage. A clipper who is always quiet is
// not news; one who is suddenly 50x louder than their own baseline is.
//
// The one deliberate exception is heuristic 5 (absolute engagement
// floor): a fixed cutoff derived from published aggregate benchmarks
// (not a fraud-specific study -- none exists), added because even the
// weakest real cohorts clear it and a hard zero at real reach is itself
// the anomaly. It stays capped by SECONDARY_MAX_SCORE like everything
// else here, and the founder explicitly accepted that a clipper who is
// genuinely always this quiet will keep tripping it -- that's fine
// because it's a badge, not an action.
//
// This module writes NOTHING to the database and touches no earning or
// status field -- it is pure computation, read by src/routes/admin.js
// and src/routes/moderator.js to attach display-only metadata.

import { maxPayoutPerVideo } from './db.js';

// Kept below the 'high' cutoff (see tierForScore) on purpose -- these
// heuristics alone must never manufacture a strong warning.
export const SECONDARY_MAX_SCORE = 55;

// A clip needs at least this many prior view-growth events before its
// "own recent rate" means anything -- otherwise the first real jump on a
// brand-new clip would always look infinite relative to nothing.
const MIN_SNAPSHOTS_FOR_BURST = 3;

// Floors so tiny numbers never register as a "burst"/ratio signal --
// real noise at low volume, not evidence of anything.
const MIN_BURST_VIEWS = 200;
const MIN_VIEWS_FOR_ENGAGEMENT_CHECK = 500;

const CAP_CLUSTER_RATIO = 0.97; // within 3% of the per-video payout ceiling

// Absolute engagement floor (heuristic 5). Gated on this many views so a
// brand-new clip's unremarkable zero comments never trips it.
const MIN_VIEWS_FOR_ABSOLUTE_FLOOR = 5000;

// Fixed cutoffs, deliberately stricter than the raw published averages
// (fewer flags, higher confidence) -- see the plan for the benchmark
// sources these are derived from. Instagram also requires a hard zero
// comments; YouTube uses a comment-ratio floor instead, since Shorts run
// lower on comments/view than Reels even organically.
const ABSOLUTE_FLOOR = {
  instagram: { likeRatio: 0.0025 }, // 0.25% likes/views, AND comments === 0
  youtube: { likeRatio: 0.005, commentRatio: 0.00025 } // 0.5% likes/views, 0.025% comments/views
};

/**
 * Maps a 0-100 score to the badge tier shown everywhere a video appears.
 * Deliberately a pure function of score, computed on read rather than
 * stored, so the tier and the score it comes from can never drift apart.
 */
export function tierForScore(score) {
  if (score == null) return null;
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  if (score >= 15) return 'low';
  return 'none';
}

/**
 * @param submission {views, likes, comments, earning, platform} --
 *   likes/comments may be null (not available for this platform/media).
 * @param snapshots submission_view_snapshots rows for this submission,
 *   OLDEST FIRST: [{views, likes, comments, recorded_at}].
 * @param clipperBaseline {medianEngagementRatio} across this SAME
 *   clipper's other clips with a meaningful view count, or null if there
 *   isn't one yet (this clipper's first scoreable clip).
 * @param campaign the campaign row, for the per-video cap check.
 * @returns {score, reasons: string[]}
 */
export function scoreSubmission({ submission, snapshots = [], clipperBaseline = null, campaign = null }) {
  let score = 0;
  const reasons = [];

  // 1. View-growth changepoint: a jump far larger than this clip's OWN
  // recent rate, landing in one sync window. Not an absolute view-count
  // threshold -- a clip that has always grown fast doesn't trigger this
  // just for being popular; only a jump relative to ITS OWN history does.
  if (snapshots.length >= MIN_SNAPSHOTS_FOR_BURST) {
    const deltas = [];
    for (let i = 1; i < snapshots.length; i++) {
      deltas.push(Math.max(0, snapshots[i].views - snapshots[i - 1].views));
    }
    const latest = deltas[deltas.length - 1];
    const priorMax = Math.max(0, ...deltas.slice(0, -1));
    if (latest >= MIN_BURST_VIEWS && priorMax > 0 && latest > priorMax * 4) {
      score += 25;
      reasons.push(`view burst: latest jump (${latest}) is ${(latest / priorMax).toFixed(1)}x this clip's own prior largest jump`);
    }
  }

  // 2. Engagement ratio vs. THIS CLIPPER'S OWN baseline -- peer-relative,
  // never a fixed cutoff, since organically low engagement is real.
  const views = submission.views || 0;
  if (clipperBaseline && clipperBaseline.medianEngagementRatio > 0 && views >= MIN_VIEWS_FOR_ENGAGEMENT_CHECK
      && submission.likes != null && submission.comments != null) {
    const engagement = (submission.likes || 0) + (submission.comments || 0);
    const ratio = engagement / views;
    if (ratio < clipperBaseline.medianEngagementRatio * 0.2) {
      score += 15;
      reasons.push(
        `engagement ratio (${(ratio * 100).toFixed(2)}%) is far below this clipper's own median (${(clipperBaseline.medianEngagementRatio * 100).toFixed(2)}%)`
      );
    }
  }

  // 3. Cap clustering -- earning landing suspiciously close to the
  // campaign's per-video payout ceiling. The specific, checkable pattern
  // that caught a real 2026 clipping-platform botting operation.
  if (campaign) {
    const maxPerVideo = maxPayoutPerVideo(campaign);
    if (maxPerVideo > 0 && submission.earning > 0) {
      const ratio = submission.earning / maxPerVideo;
      if (ratio >= CAP_CLUSTER_RATIO && ratio <= 1) {
        score += 15;
        reasons.push(`earning (₹${submission.earning}) is within 3% of this campaign's per-video cap (₹${maxPerVideo})`);
      }
    }
  }

  // 4. A platform-side downward correction -- logged as an observed fact
  // for whoever reads the reason, but never itself penalized: this can be
  // YouTube/Instagram's own legitimate spam-filter correction, not
  // evidence the clipper did anything.
  if (snapshots.length >= 2) {
    const last = snapshots[snapshots.length - 1];
    const prev = snapshots[snapshots.length - 2];
    if (last.views < prev.views) {
      reasons.push(`the platform itself later revised views down (${prev.views} → ${last.views}) -- not treated as suspicious on its own`);
    }
  }

  // 5. Absolute engagement floor -- unlike #2, a FIXED cutoff, not
  // peer-relative (see the file header for why this one exception is
  // justified). Real reach into the tens of thousands of views almost
  // always draws SOME trickle of comments from strangers via Explore/
  // Shorts feed, not just followers -- a hard zero at that scale is
  // itself the stranger number, more so than a low like ratio alone.
  const floor = ABSOLUTE_FLOOR[submission.platform];
  if (floor && views >= MIN_VIEWS_FOR_ABSOLUTE_FLOOR && submission.likes != null && submission.comments != null) {
    const likeRatio = (submission.likes || 0) / views;
    const belowFloor = submission.platform === 'instagram'
      ? likeRatio < floor.likeRatio && submission.comments === 0
      : likeRatio < floor.likeRatio && (submission.comments || 0) / views < floor.commentRatio;
    if (belowFloor) {
      score += 20;
      reasons.push(
        `likes/views (${(likeRatio * 100).toFixed(2)}%) and comments (${submission.comments}) are both below the floor real organic reach at this view count almost never falls under`
      );
    }
  }

  return { score: Math.min(score, SECONDARY_MAX_SCORE), reasons };
}

/**
 * A clipper's own baseline engagement ratio, from their other clips that
 * have enough views for the ratio to mean anything and actually report
 * likes/comments. Returns null (not zero) when there isn't one yet --
 * callers must treat "no baseline" as "skip this heuristic", never as
 * "baseline is zero".
 */
export function computeClipperBaseline(otherSubmissions) {
  const ratios = (otherSubmissions || [])
    .filter(s => (s.views || 0) >= MIN_VIEWS_FOR_ENGAGEMENT_CHECK && s.likes != null && s.comments != null)
    .map(s => ((s.likes || 0) + (s.comments || 0)) / s.views);
  if (!ratios.length) return null;
  ratios.sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  return { medianEngagementRatio: median, sampleSize: ratios.length };
}
