// A revoked YouTube token used to be invisible to the clipper. The chained
// refresh engine recorded the failure only in the job's own accounts_json,
// which is discarded when the panel closes -- the social_accounts row kept
// reading 'connected'. Both the campaign warning and the Reconnect button are
// gated on that row, so neither ever appeared and the clipper simply watched
// their view counts stop moving with no explanation.
//
// These tests pin the two facts the fix depends on: the account gets flagged,
// and a working batch never gets flagged by mistake.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { runChunk, createRefreshJob } from '../src/refresh-jobs.js';

const NOW = Date.now();

function seed() {
  return makeSqliteD1({
    clippers: [{ id: 1, username: 'c', password_hash: 'h', password_salt: 's', created_at: NOW }],
    campaigns: [{ id: 1, name: 'C', cpm: 40, budget: 100000, status: 'active',
                  created_at: NOW, min_views: 1000, allowed_platforms: 'youtube' }],
    social_accounts: [{ id: 10, clipper_id: 1, platform: 'youtube', external_id: 'UC1',
                        username: '@chan', account_type: 'channel', access_token: 't',
                        refresh_token: 'r', status: 'connected', connected_at: NOW, auto_import: 0,
                        // Far-future expiry: withFreshToken treats a missing or near
                        // expiry as stale and would attempt a real Google refresh.
                        token_expires_at: NOW + 3600000 }],
    participations: [{ id: 100, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW, account_id: 10 }],
    participation_accounts: [{ id: 1000, participation_id: 100, account_id: 10, platform: 'youtube', linked_at: NOW }],
    submissions: [
      { id: 900, clipper_id: 1, campaign_id: 1, account_id: 10, platform: 'youtube',
        ig_media_id: 'v900', permalink: 'https://youtube.com/shorts/v900', views: 500,
        earning: 0, status: 'active', created_at: NOW - 7200000, eligible: 1 },
      { id: 901, clipper_id: 1, campaign_id: 1, account_id: 10, platform: 'youtube',
        ig_media_id: 'v901', permalink: 'https://youtube.com/shorts/v901', views: 300,
        earning: 0, status: 'active', created_at: NOW - 7200000, eligible: 1 }
    ]
  });
}

const acct = (db) => db._sqlite.prepare('SELECT * FROM social_accounts WHERE id = 10').get();

async function runWith(db, fetchViews) {
  const created = await createRefreshJob(db, { kind: 'global', triggeredBy: 'test', respectCooldown: false });
  assert.ok(created.job_id, created.error || 'job should create');
  for (let i = 0; i < 10; i++) {
    const r = await runChunk(db, {}, created.job_id, { adapters: { youtube: { listRecent: async () => [], fetchViews } } });
    if (r && r.done) break;
  }
}

test('a revoked token flags the account so the clipper is told', async () => {
  const db = seed();
  await runWith(db, async (_a, ids) =>
    new Map(ids.map(id => [id, { ok: false, code: 'TOKEN_REVOKED', needsReauth: true }])));

  const a = acct(db);
  assert.equal(a.status, 'needs_reauth', 'the account must be flagged, not left reading connected');
  assert.equal(a.last_error_code, 'TOKEN_REVOKED', 'and must record why, so the UI can explain it');
});

test('a healthy refresh never flags the account', async () => {
  const db = seed();
  await runWith(db, async (_a, ids) => new Map(ids.map(id => [id, { ok: true, views: 1234 }])));
  assert.equal(acct(db).status, 'connected');
});

test('one dead video does not get mistaken for a dead connection', async () => {
  // A batch where some clips read fine is a per-video problem. Flagging here
  // would tell a clipper to reconnect a connection that is working.
  const db = seed();
  await runWith(db, async (_a, ids) => new Map(ids.map((id, i) =>
    [id, i === 0 ? { ok: true, views: 900 } : { ok: false, code: 'TOKEN_REVOKED', needsReauth: true }])));

  assert.equal(acct(db).status, 'connected', 'a partly-working batch is not a dead token');
});

test('reconnecting keeps every clip — the account row is reused, not replaced', async () => {
  // This is what makes reconnect safe to ask a clipper to do: the OAuth
  // callback matches on external_id and UPDATEs, so account_id never changes
  // and no submission is orphaned.
  const db = seed();
  db._sqlite.prepare(
    "UPDATE social_accounts SET status='needs_reauth', last_error_code='TOKEN_REVOKED', access_token=NULL WHERE id=10"
  ).run();

  const before = db._rows('submissions').length;

  // Exactly what youtube-auth.js does when the same channel comes back.
  const existing = db._sqlite.prepare(
    "SELECT id FROM social_accounts WHERE clipper_id = 1 AND platform = 'youtube' AND external_id = 'UC1'"
  ).get();
  assert.equal(existing.id, 10, 'the same channel must resolve to the same row');

  db._sqlite.prepare(
    `UPDATE social_accounts SET access_token='fresh', refresh_token='r2', status='connected',
       last_error_code=NULL, last_error_at=NULL WHERE id=?`
  ).run(existing.id);

  const a = acct(db);
  assert.equal(a.status, 'connected');
  assert.equal(a.last_error_code, null, 'the warning must clear');
  assert.equal(a.connected_at, NOW, 'connected_at must NOT move, or older posts stop importing');
  assert.equal(db._rows('submissions').length, before, 'no clip may be lost');
  assert.equal(db._rows('submissions').every(s => s.account_id === 10), true, 'and none orphaned');
});
