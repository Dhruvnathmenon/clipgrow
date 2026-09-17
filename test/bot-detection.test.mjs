// Secondary, single-clip risk heuristics -- deliberately capped below the
// 'high' tier (see Part 2 of the founder-approved plan: no single-clip
// formula is reliable enough to carry a strong warning alone). The most
// important case here is the false-positive this whole module exists to
// avoid: a genuinely quiet, real clip must never score high just for
// having low engagement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreSubmission, computeClipperBaseline, tierForScore, SECONDARY_MAX_SCORE } from '../src/bot-detection.js';

const T = Date.parse('2026-09-01T00:00:00Z');
const HOUR = 60 * 60 * 1000;
const snap = (hoursFromStart, views, likes = null, comments = null) => ({
  recorded_at: T + hoursFromStart * HOUR, views, likes, comments
});

test('tierForScore: the four bands', () => {
  assert.equal(tierForScore(null), null, 'not yet scored -- no badge at all');
  assert.equal(tierForScore(0), 'none');
  assert.equal(tierForScore(14), 'none');
  assert.equal(tierForScore(15), 'low');
  assert.equal(tierForScore(39), 'low');
  assert.equal(tierForScore(40), 'medium');
  assert.equal(tierForScore(69), 'medium');
  assert.equal(tierForScore(70), 'high');
  assert.equal(tierForScore(100), 'high');
});

test('a genuinely quiet but real clip scores low, never high -- the exact false positive this system must avoid', () => {
  // Steady, gradual, organic-looking growth; no engagement at all, but no
  // baseline to compare against either (this clipper's first scored clip).
  const submission = { views: 5000, likes: 2, comments: 0, earning: 250 };
  const snapshots = [snap(0, 1000), snap(6, 2000), snap(12, 3200), snap(18, 4100), snap(24, 5000)];
  const { score, reasons } = scoreSubmission({ submission, snapshots, clipperBaseline: null, campaign: null });
  assert.ok(score < 40, `score ${score} should stay in none/low, not medium/high, for organically quiet growth`);
});

test('a view burst far larger than the clip\'s own prior largest jump scores it up', () => {
  const submission = { views: 50000, likes: 100, comments: 10, earning: 2500 };
  // Prior deltas: 1000, 1000, 1000 -- then a sudden 40,000-view jump.
  const snapshots = [snap(0, 1000), snap(6, 2000), snap(12, 3000), snap(18, 4000), snap(24, 44000)];
  const { score, reasons } = scoreSubmission({ submission, snapshots, clipperBaseline: null, campaign: null });
  assert.ok(score >= 25, `expected the burst heuristic to fire, got score ${score}`);
  assert.ok(reasons.some(r => /view burst/.test(r)));
});

test('a small clip\'s normal noise never triggers the burst heuristic (floor)', () => {
  const submission = { views: 30, likes: 1, comments: 0, earning: 1 };
  const snapshots = [snap(0, 2), snap(6, 5), snap(12, 8), snap(18, 30)]; // tiny numbers throughout
  const { score } = scoreSubmission({ submission, snapshots, clipperBaseline: null, campaign: null });
  assert.equal(score, 0, 'below MIN_BURST_VIEWS -- noise, not a signal');
});

test('engagement ratio far below the clipper\'s OWN baseline scores it up -- never an absolute cutoff', () => {
  const baseline = computeClipperBaseline([
    { views: 10000, likes: 300, comments: 50 }, // ratio 3.5%
    { views: 8000, likes: 200, comments: 40 }   // ratio 3%
  ]);
  assert.ok(baseline.medianEngagementRatio > 0.02);

  const quietButHighEngagement = { views: 10000, likes: 350, comments: 60, earning: 500 };
  const noisy = scoreSubmission({ submission: quietButHighEngagement, snapshots: [], clipperBaseline: baseline, campaign: null });
  assert.equal(noisy.score, 0, 'engagement in line with this clipper\'s own baseline is not suspicious');

  const suddenlyQuiet = { views: 10000, likes: 1, comments: 0, earning: 500 };
  const flagged = scoreSubmission({ submission: suddenlyQuiet, snapshots: [], clipperBaseline: baseline, campaign: null });
  assert.ok(flagged.score >= 15, 'far below this clipper\'s own median ratio should score it up');
  assert.ok(flagged.reasons.some(r => /engagement ratio/.test(r)));
});

test('a clipper\'s first clip (no baseline yet) never triggers the engagement heuristic', () => {
  const submission = { views: 10000, likes: 0, comments: 0, earning: 500 };
  const { score } = scoreSubmission({ submission, snapshots: [], clipperBaseline: null, campaign: null });
  assert.equal(score, 0, 'nothing to compare against -- must not assume a fixed cutoff');
});

test('earning landing within 3% of the campaign\'s per-video cap scores it up', () => {
  const campaign = { blueprint_json: JSON.stringify({ max_payout: 1000 }) };
  const rightAtCap = { views: 20000, likes: 50, comments: 5, earning: 990 };
  const { score, reasons } = scoreSubmission({ submission: rightAtCap, snapshots: [], clipperBaseline: null, campaign });
  assert.ok(score >= 15);
  assert.ok(reasons.some(r => /per-video cap/.test(r)));

  const wellBelowCap = { views: 5000, likes: 50, comments: 5, earning: 250 };
  const clean = scoreSubmission({ submission: wellBelowCap, snapshots: [], clipperBaseline: null, campaign });
  assert.equal(clean.score, 0);
});

test('a platform-side downward correction is logged as context, never penalized on its own', () => {
  const submission = { views: 9000, likes: 50, comments: 5, earning: 450 };
  const snapshots = [snap(0, 10000), snap(6, 9000)]; // views went DOWN
  const { score, reasons } = scoreSubmission({ submission, snapshots, clipperBaseline: null, campaign: null });
  assert.equal(score, 0, 'a platform correction alone must not score the clip up');
  assert.ok(reasons.some(r => /revised views down/.test(r)), 'but it is still surfaced as context for whoever reads the reason');
});

test('secondary heuristics combined never exceed SECONDARY_MAX_SCORE, keeping them out of the high tier', () => {
  const baseline = computeClipperBaseline([{ views: 10000, likes: 500, comments: 100 }]); // 6%
  const campaign = { blueprint_json: JSON.stringify({ max_payout: 1000 }) };
  const submission = { views: 50000, likes: 0, comments: 0, earning: 990 };
  const snapshots = [snap(0, 1000), snap(6, 2000), snap(12, 3000), snap(18, 4000), snap(24, 44000)];
  const { score } = scoreSubmission({ submission, snapshots, clipperBaseline: baseline, campaign });
  assert.ok(score <= SECONDARY_MAX_SCORE);
  assert.ok(tierForScore(score) !== 'high', 'secondary signals alone must never reach the high tier');
});

test('computeClipperBaseline: median across qualifying clips, ignoring ones with no likes/comments data or too few views', () => {
  const rows = [
    { views: 10000, likes: 100, comments: 20 },   // 1.2%
    { views: 20000, likes: 600, comments: 400 },  // 5%
    { views: 100, likes: 5, comments: 1 },        // below the views floor -- excluded
    { views: 5000, likes: null, comments: null }  // no engagement data -- excluded
  ];
  const baseline = computeClipperBaseline(rows);
  assert.equal(baseline.sampleSize, 2);
  assert.ok(baseline.medianEngagementRatio > 0.01 && baseline.medianEngagementRatio < 0.05);
});

test('computeClipperBaseline: null (not zero) when nothing qualifies', () => {
  assert.equal(computeClipperBaseline([]), null);
  assert.equal(computeClipperBaseline([{ views: 10, likes: 1, comments: 0 }]), null);
});

test('absolute floor: the exact real-world case that motivated it -- 40k views, 80 likes, 0 comments on Instagram', () => {
  const submission = { views: 40000, likes: 80, comments: 0, earning: 2000, platform: 'instagram' };
  const { score, reasons } = scoreSubmission({ submission, snapshots: [], clipperBaseline: null, campaign: null });
  assert.ok(score >= 15, `expected the absolute-floor heuristic to fire for this exact case, got score ${score}`);
  assert.ok(reasons.some(r => /below the floor/.test(r)));
});

test('absolute floor: below the view floor (<5,000 views), zero comments is unremarkable and does not fire', () => {
  const submission = { views: 4000, likes: 5, comments: 0, earning: 200, platform: 'instagram' };
  const { score } = scoreSubmission({ submission, snapshots: [], clipperBaseline: null, campaign: null });
  assert.equal(score, 0, 'too few views for a zero-comment count to mean anything');
});

test('absolute floor: a low like ratio alone, with nonzero comments, does not fire on Instagram -- both conditions are required', () => {
  const submission = { views: 40000, likes: 80, comments: 3, earning: 2000, platform: 'instagram' };
  const { score } = scoreSubmission({ submission, snapshots: [], clipperBaseline: null, campaign: null });
  assert.equal(score, 0, 'a real trickle of comments clears the floor even with a quiet like ratio');
});

test('absolute floor: YouTube uses a comment-ratio floor instead of a hard zero', () => {
  const belowFloor = { views: 40000, likes: 150, comments: 5, earning: 2000, platform: 'youtube' }; // 0.375% likes, 0.0125% comments
  const flagged = scoreSubmission({ submission: belowFloor, snapshots: [], clipperBaseline: null, campaign: null });
  assert.ok(flagged.score >= 15, `expected YouTube's floor to fire, got score ${flagged.score}`);

  const clearsIt = { views: 40000, likes: 150, comments: 20, earning: 2000, platform: 'youtube' }; // 0.375% likes, 0.05% comments
  const clean = scoreSubmission({ submission: clearsIt, snapshots: [], clipperBaseline: null, campaign: null });
  assert.equal(clean.score, 0, 'enough comments clears YouTube\'s comment-ratio floor even with a quiet like ratio');
});

test('absolute floor: never fires above the floor, on either platform', () => {
  const goodInstagram = { views: 40000, likes: 800, comments: 20, earning: 2000, platform: 'instagram' }; // 2% likes
  assert.equal(scoreSubmission({ submission: goodInstagram, snapshots: [], clipperBaseline: null, campaign: null }).score, 0);

  const goodYoutube = { views: 40000, likes: 2000, comments: 100, earning: 2000, platform: 'youtube' }; // 5% likes, 0.25% comments
  assert.equal(scoreSubmission({ submission: goodYoutube, snapshots: [], clipperBaseline: null, campaign: null }).score, 0);
});
