// The primary bot-detection signal (see .claude's plan / the founder
// conversation this shipped from): cross-account timing correlation,
// adapted from SynchroTrap. Deliberately proven here against exactly the
// two false-positive cases raised while building this -- an old account
// resuming activity, and a single clip going organically viral -- since
// those are the whole reason this signal was chosen over a per-clip score.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCorrelatedClusters, BUCKET_MS } from '../src/bot-correlation.js';

const HOUR_1 = Date.parse('2026-09-01T00:00:00Z');
const bucket = (n) => HOUR_1 + n * BUCKET_MS;
const snap = (bucketIndex) => ({ recorded_at: bucket(bucketIndex) });

test('two DIFFERENT clippers growing in the exact same hourly buckets, repeatedly, get clustered', () => {
  const entries = [
    { submissionId: 1, clipperId: 'A', snapshots: [snap(0), snap(1), snap(2), snap(3)] },
    { submissionId: 2, clipperId: 'B', snapshots: [snap(0), snap(1), snap(2), snap(3)] }
  ];
  const clusters = findCorrelatedClusters(entries);
  assert.equal(clusters.get(1), clusters.get(2), 'both submissions land in the same cluster');
  assert.ok(clusters.get(1) != null, 'the cluster id is set, not null');
});

test('the SAME clipper correlating with themselves is expected and never flagged', () => {
  const entries = [
    { submissionId: 1, clipperId: 'A', snapshots: [snap(0), snap(1), snap(2), snap(3)] },
    { submissionId: 2, clipperId: 'A', snapshots: [snap(0), snap(1), snap(2), snap(3)] }
  ];
  const clusters = findCorrelatedClusters(entries);
  assert.equal(clusters.size, 0, 'no cluster at all -- same-clipper timing overlap is meaningless');
});

test('an old account resuming activity alone is never flagged -- there is nothing to correlate against', () => {
  // Only one submission in the whole system with real growth activity --
  // by construction, correlation needs at least two DIFFERENT accounts.
  const entries = [
    { submissionId: 1, clipperId: 'RESTARTED', snapshots: [snap(0), snap(5), snap(20)] }
  ];
  const clusters = findCorrelatedClusters(entries);
  assert.equal(clusters.size, 0);
});

test('a single account going organically viral alone produces no correlation signal', () => {
  // One huge, idiosyncratic spike on one clip; a handful of OTHER, totally
  // unrelated clippers growing on their own unrelated schedule. None of
  // them share a repeated timing pattern with the viral clip.
  const entries = [
    { submissionId: 1, clipperId: 'VIRAL', snapshots: [snap(0), snap(1), snap(2)] },
    { submissionId: 2, clipperId: 'X', snapshots: [snap(10), snap(40), snap(90)] },
    { submissionId: 3, clipperId: 'Y', snapshots: [snap(5), snap(60), snap(100)] }
  ];
  const clusters = findCorrelatedClusters(entries);
  assert.equal(clusters.get(1), undefined, 'the viral clip is not flagged just for spiking alone');
  assert.equal(clusters.size, 0);
});

test('a transitive chain (A~B, B~C) forms one cluster even if A and C alone fall short', () => {
  // A and B share buckets 0-3; B and C share buckets 4-7. A and C share
  // nothing directly, but a bot farm's own internal scheduling drift
  // across many orders would look exactly like this -- not identical down
  // to the second between every pair, but chained through a common node.
  const entries = [
    { submissionId: 1, clipperId: 'A', snapshots: [snap(0), snap(1), snap(2), snap(3)] },
    { submissionId: 2, clipperId: 'B', snapshots: [snap(0), snap(1), snap(2), snap(3), snap(4), snap(5), snap(6), snap(7)] },
    { submissionId: 3, clipperId: 'C', snapshots: [snap(4), snap(5), snap(6), snap(7)] }
  ];
  const clusters = findCorrelatedClusters(entries);
  assert.equal(clusters.get(1), clusters.get(2));
  assert.equal(clusters.get(2), clusters.get(3));
});

test('fewer than the minimum shared buckets never triggers a cluster, even at perfect overlap', () => {
  const entries = [
    { submissionId: 1, clipperId: 'A', snapshots: [snap(0), snap(1)] }, // only 2 buckets
    { submissionId: 2, clipperId: 'B', snapshots: [snap(0), snap(1)] }
  ];
  const clusters = findCorrelatedClusters(entries, { minBuckets: 3 });
  assert.equal(clusters.size, 0);
});

test('a lower similarity threshold catches a looser (but still suspicious) match', () => {
  // 3 of 4 buckets shared -- Jaccard 3/5 = 0.6, below the default 0.9 but
  // above a deliberately loosened threshold, confirming the constant is
  // load-bearing and not just decorative.
  const entries = [
    { submissionId: 1, clipperId: 'A', snapshots: [snap(0), snap(1), snap(2), snap(3)] },
    { submissionId: 2, clipperId: 'B', snapshots: [snap(0), snap(1), snap(2), snap(9)] }
  ];
  assert.equal(findCorrelatedClusters(entries, { similarityThreshold: 0.9 }).size, 0);
  assert.equal(findCorrelatedClusters(entries, { similarityThreshold: 0.5 }).size, 2);
});
