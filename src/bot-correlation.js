// Primary, high-confidence bot-view signal: cross-account timing
// correlation, adapted from SynchroTrap (Xiao, Xie, Kulkarni et al.,
// Facebook/Instagram security team, ACM CCS 2014, "Uncovering Large
// Groups of Active Malicious Accounts in Online Social Networks") --
// deployed in five production applications at Facebook/Instagram,
// reportedly catching 2M+ malicious accounts across 1,156 attack
// campaigns in one month with a near-zero false-positive rate.
//
// The core idea, in SynchroTrap's own words: malicious accounts perform
// "loosely synchronized actions" -- humans cannot stay highly synchronous
// with STRANGERS for long, so a set of accounts whose activity keeps
// lining up in time, tighter than chance would ever produce, is almost
// certainly not independent organic behaviour. This is deliberately NOT
// a per-clip score -- it looks ACROSS clips/accounts for a pattern no
// single video's numbers could ever reveal on their own, which is why it
// survives the two false-positive cases raised while building this
// system:
//   1. An old, large account that got wiped and restarted with fresh
//      content -- this method never looks at an account's own history or
//      size, only whether ITS timing lines up with OTHER unrelated
//      accounts'. A real restart has no mechanism that synchronizes it
//      with strangers.
//   2. A brand-new account that organically goes viral -- a real viral
//      spike is a single, idiosyncratic event with nothing to correlate
//      against. Correlation requires a SHARED pattern across multiple
//      entities; one video spiking alone produces no signal by
//      definition.
// The honest limit: a single, well-funded operator botting exactly one
// clip, running no other orders anywhere else on ClipGrow at the same
// time, has nothing to correlate against either. But the real-world case
// motivating this system was a SCALED operation serving many clients at
// once -- exactly the shape this catches.
//
// Deliberately simpler than SynchroTrap's own production system (which
// needed Hadoop/Giraph purely because of Facebook's account volume, not
// because the underlying method is complex), and NOT FRAUDAR/CopyCatch
// (which need a bipartite user-object graph ClipGrow doesn't have) --
// this is SynchroTrap's timing-only mechanism, which is exactly what
// submission_view_snapshots captures for free: no IP data, no device
// data, no platform cooperation beyond what's already fetched.
//
// This module writes NOTHING to the database and never touches earning
// or status -- it returns cluster assignments for the caller to persist
// as pure display metadata (submissions.bot_correlation_cluster_id).

// How finely to bucket time when comparing two submissions' growth-event
// timing. Matches the 1-hour sync cooldown in rate-budget.js -- there is
// no point resolving finer than the granularity syncing itself happens at.
export const BUCKET_MS = 60 * 60 * 1000;

// Minimum shared growth-event buckets before two submissions are even
// compared. A single coincidental overlap proves nothing -- the signal is
// in REPEATED alignment over time.
export const MIN_BUCKETS = 3;

// Jaccard similarity above which two DIFFERENT clippers' clips are
// considered suspiciously synchronized. Roughly the figure cited in the
// correlated-engagement-timing literature this is based on -- kept as a
// named constant, not a magic number, so it's easy to revisit once real
// production score distributions exist.
export const SIMILARITY_THRESHOLD = 0.9;

function toBuckets(snapshots) {
  // A Set, not an array -- what matters is WHICH hours had a growth
  // event, not how many events landed in the same hour.
  return new Set((snapshots || []).map(s => Math.floor(s.recorded_at / BUCKET_MS)));
}

function jaccard(a, b) {
  let intersect = 0;
  for (const x of a) if (b.has(x)) intersect++;
  const union = a.size + b.size - intersect;
  return union ? intersect / union : 0;
}

/**
 * @param entries [{ submissionId, clipperId, snapshots: [{recorded_at}] }]
 *   -- typically every active submission with at least one snapshot in a
 *   recent rolling window (e.g. trailing 14 days).
 * @returns Map(submissionId -> clusterId) for every submission that
 *   landed in a flagged cluster of 2+ DIFFERENT clippers. Submissions
 *   absent from the returned map are unflagged by this detector (they
 *   may still carry a secondary score from bot-detection.js).
 */
export function findCorrelatedClusters(entries, { similarityThreshold = SIMILARITY_THRESHOLD, minBuckets = MIN_BUCKETS } = {}) {
  const withBuckets = (entries || [])
    .map(e => ({ submissionId: e.submissionId, clipperId: e.clipperId, buckets: toBuckets(e.snapshots) }))
    .filter(e => e.buckets.size >= minBuckets);

  // Union-find over pairs that clear the threshold -- a transitive chain
  // (A~B, B~C) still forms one cluster even if A and C alone fall just
  // short, matching how a bot farm's own internal scheduling drift would
  // actually look across many orders, not identical down to the second.
  const parent = new Map(withBuckets.map(e => [e.submissionId, e.submissionId]));
  const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  const union = (x, y) => { const rx = find(x), ry = find(y); if (rx !== ry) parent.set(rx, ry); };

  for (let i = 0; i < withBuckets.length; i++) {
    for (let j = i + 1; j < withBuckets.length; j++) {
      const a = withBuckets[i], b = withBuckets[j];
      // Same-clipper correlation is expected and meaningless -- a
      // clipper's own clips naturally sync to THEIR OWN posting/sync
      // cadence. Only different clippers correlating is the anomaly.
      if (a.clipperId === b.clipperId) continue;
      if (jaccard(a.buckets, b.buckets) >= similarityThreshold) union(a.submissionId, b.submissionId);
    }
  }

  const groups = new Map();
  for (const e of withBuckets) {
    const root = find(e.submissionId);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(e.submissionId);
  }

  const result = new Map();
  let nextClusterId = 1;
  for (const members of groups.values()) {
    if (members.length < 2) continue; // a cluster of one proves nothing
    for (const id of members) result.set(id, nextClusterId);
    nextClusterId++;
  }
  return result;
}

// A flagged correlation cluster is the one signal in this system trusted
// enough to reach the 'high' tier on its own (see bot-detection.js's
// tierForScore: 'high' starts at 70).
export const CORRELATION_SCORE = 85;
