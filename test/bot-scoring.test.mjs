// End-to-end (against the real schema) test of the orchestrator that
// piggybacks on the existing refresh-job completion hook (src/worker.js).
// Proves the two detectors actually combine correctly through real D1
// writes, and -- the one rule that always applies (CLAUDE.md) -- that
// scoring NEVER touches earning, status, or lock fields, only the new
// informational columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { scoreRecentSubmissions } from '../src/bot-scoring.js';

const NOW = Date.parse('2026-09-15T00:00:00Z');
const HOUR = 60 * 60 * 1000;

function seed(extra = {}) {
  return makeSqliteD1({
    clippers: [
      { id: 1, username: 'c1', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW },
      { id: 2, username: 'c2', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW },
      { id: 3, username: 'c3', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }
    ],
    campaigns: [
      { id: 1, name: 'T', cpm: 50, budget: 1000000, status: 'active', created_at: NOW,
        min_views: 1000, allowed_platforms: 'instagram', campaign_kind: 'client', fee_percent: 20 }
    ],
    ...extra
  });
}

const sub = (o) => ({
  clipper_id: 1, campaign_id: 1, ig_media_id: 'm' + (o.id || 1), permalink: 'p' + (o.id || 1), views: 10000, earning: 500,
  status: 'active', eligible: 1, created_at: NOW, ...o
});

const snapAt = (submissionId, clipperId, hour, views) =>
  ({ submission_id: submissionId, clipper_id: clipperId, views, likes: null, comments: null, recorded_at: NOW + hour * HOUR });

test('a synchronized cluster across two different clippers gets a high-confidence bot_score and a shared cluster id', async () => {
  const db = seed({
    submissions: [
      sub({ id: 1, clipper_id: 1, views: 40000, earning: 2000 }),
      sub({ id: 2, clipper_id: 2, views: 40000, earning: 2000 })
    ],
    submission_view_snapshots: [
      snapAt(1, 1, 0, 10000), snapAt(1, 1, 1, 20000), snapAt(1, 1, 2, 30000), snapAt(1, 1, 3, 40000),
      snapAt(2, 2, 0, 10000), snapAt(2, 2, 1, 20000), snapAt(2, 2, 2, 30000), snapAt(2, 2, 3, 40000)
    ]
  });

  const r = await scoreRecentSubmissions(db, { now: NOW + 4 * HOUR });
  assert.equal(r.scored, 2);
  assert.equal(r.clusters, 1);

  const s1 = await db.prepare('SELECT * FROM submissions WHERE id = 1').first();
  const s2 = await db.prepare('SELECT * FROM submissions WHERE id = 2').first();
  assert.ok(s1.bot_score >= 70, 'a flagged correlation cluster reaches the high tier');
  assert.equal(s1.bot_correlation_cluster_id, s2.bot_correlation_cluster_id, 'both submissions share the same cluster id');
  assert.ok(/synchronized with other clippers/.test(s1.bot_score_reason));
  assert.ok(s1.bot_scored_at != null);
});

test('an isolated, gradually-growing clip with no correlated partner is never pushed into the high tier', async () => {
  const db = seed({
    submissions: [sub({ id: 1, clipper_id: 1, views: 5000, earning: 250 })],
    submission_view_snapshots: [
      snapAt(1, 1, 0, 1000), snapAt(1, 1, 6, 2000), snapAt(1, 1, 12, 3200), snapAt(1, 1, 18, 5000)
    ]
  });

  await scoreRecentSubmissions(db, { now: NOW + 18 * HOUR });
  const s1 = await db.prepare('SELECT * FROM submissions WHERE id = 1').first();
  assert.equal(s1.bot_correlation_cluster_id, null);
  assert.ok(s1.bot_score < 70, 'no correlation partner and no burst -- must not reach the high tier alone');
});

test('scoring never touches earning, status, or any lock field -- only the informational columns move', async () => {
  const db = seed({
    submissions: [sub({ id: 1, clipper_id: 1, views: 40000, earning: 2000 }), sub({ id: 2, clipper_id: 2, views: 40000, earning: 2000 })],
    submission_view_snapshots: [
      snapAt(1, 1, 0, 10000), snapAt(1, 1, 1, 20000), snapAt(1, 1, 2, 30000), snapAt(1, 1, 3, 40000),
      snapAt(2, 2, 0, 10000), snapAt(2, 2, 1, 20000), snapAt(2, 2, 2, 30000), snapAt(2, 2, 3, 40000)
    ]
  });
  const before1 = await db.prepare('SELECT views, earning, status, locked_at FROM submissions WHERE id = 1').first();

  await scoreRecentSubmissions(db, { now: NOW + 4 * HOUR });

  const after1 = await db.prepare('SELECT views, earning, status, locked_at FROM submissions WHERE id = 1').first();
  assert.deepEqual(after1, before1, 'a flagged clip is never auto-paused, disqualified, or re-priced by scoring alone');
});

test('a locked (paid) submission is left alone entirely -- it never even reaches the scoring query', async () => {
  const db = seed({
    submissions: [
      sub({ id: 1, clipper_id: 1, views: 40000, earning: 2000, locked_at: NOW, locked_earning: 2000, lock_reason: 'paid' }),
      sub({ id: 2, clipper_id: 2, views: 40000, earning: 2000 })
    ],
    submission_view_snapshots: [
      snapAt(1, 1, 0, 10000), snapAt(1, 1, 1, 20000), snapAt(1, 1, 2, 30000), snapAt(1, 1, 3, 40000),
      snapAt(2, 2, 0, 10000), snapAt(2, 2, 1, 20000), snapAt(2, 2, 2, 30000), snapAt(2, 2, 3, 40000)
    ]
  });

  const r = await scoreRecentSubmissions(db, { now: NOW + 4 * HOUR });
  assert.equal(r.scored, 1, 'only the unlocked submission gets scored');

  const locked = await db.prepare('SELECT bot_score, bot_correlation_cluster_id FROM submissions WHERE id = 1').first();
  assert.equal(locked.bot_score, null, 'the locked clip is untouched -- no score, no cluster id');
});

test('no snapshots in the lookback window at all is a clean no-op', async () => {
  const db = seed({ submissions: [sub({ id: 1 })] });
  const r = await scoreRecentSubmissions(db, { now: NOW });
  assert.deepEqual(r, { scored: 0, clusters: 0 });
});
