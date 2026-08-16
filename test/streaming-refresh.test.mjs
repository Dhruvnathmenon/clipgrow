// Direct test of the live-progress SSE generator (syncAccountClipsStream),
// bypassing HTTP and the network entirely via the same fetchOne injection
// seam used to test the adapters. This is deliberately the more rigorous
// proof over an HTTP/SSE integration test: local `wrangler dev` on this
// machine restarts Miniflare on essentially every request regardless of
// what the request does (confirmed against a freshly-started server with no
// application writes in flight), making request-timing-sensitive local
// integration tests unreliable through no fault of the handler itself. This
// test exercises the exact same generator the route calls, with a fake D1
// and a fake network layer, so it's deterministic and fast.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeD1 } from './helpers/fake-d1.mjs';
import { syncAccountClipsStream } from '../src/earnings.js';

function makeSubmissionsTable(subs) {
  // Extends the fake D1 with just enough `submissions` handling for what
  // syncAccountClipsStream actually writes: per-clip UPDATE statements.
  const rows = new Map(subs.map(s => [s.id, { ...s }]));
  return {
    handle(sql, args) {
      if (/^UPDATE submissions SET views = \?, last_synced_at = \?, last_ok_sync_at = \?, sync_error = NULL WHERE id = \?/.test(sql)) {
        const [views, lastSynced, lastOk, id] = args;
        Object.assign(rows.get(id), { views, last_synced_at: lastSynced, last_ok_sync_at: lastOk, sync_error: null });
        return { meta: {} };
      }
      if (/^UPDATE submissions SET sync_error = \?, last_synced_at = \? WHERE id = \?/.test(sql)) {
        const [code, lastSynced, id] = args;
        Object.assign(rows.get(id), { sync_error: code, last_synced_at: lastSynced });
        return { meta: {} };
      }
      if (/^UPDATE submissions SET sync_error = \? WHERE id = \?/.test(sql)) {
        const [code, id] = args;
        Object.assign(rows.get(id), { sync_error: code });
        return { meta: {} };
      }
      return null;
    },
    rows
  };
}

function makeTestDb(subs) {
  const base = makeFakeD1();
  const subsTable = makeSubmissionsTable(subs);
  const origPrepare = base.prepare.bind(base);
  base.prepare = (sql) => {
    if (/UPDATE submissions/.test(sql)) {
      let args = [];
      return {
        bind: (...a) => { args = a; return { run: async () => subsTable.handle(sql, args) }; }
      };
    }
    return origPrepare(sql);
  };
  base._subs = subsTable.rows;
  return base;
}

// social_accounts lookups aren't hit by this generator directly (account is
// passed in already-loaded), so no extra fake table is needed for that.

test('syncAccountClipsStream: yields one progress event per clip, in order, as each completes', async () => {
  const subs = [
    { id: 1, ig_media_id: 'm1', last_ok_sync_at: null },
    { id: 2, ig_media_id: 'm2', last_ok_sync_at: null },
    { id: 3, ig_media_id: 'm3', last_ok_sync_at: null }
  ];
  const db = makeTestDb(subs);
  const account = { id: 42, platform: 'instagram', access_token: 'tok', status: 'connected' };
  const viewsById = { m1: 100, m2: 200, m3: 300 };
  const fetchOne = async (id, token, { onAttempt } = {}) => { if (onAttempt) onAttempt(); return viewsById[id]; };

  const events = [];
  for await (const ev of syncAccountClipsStream(db, {}, account, subs, { fetchOne })) events.push(ev);

  const progress = events.filter(e => e.type === 'progress');
  assert.equal(progress.length, 3);
  assert.deepEqual(progress.map(p => [p.done, p.total, p.clip_id, p.ok, p.views]), [
    [1, 3, 1, true, 100],
    [2, 3, 2, true, 200],
    [3, 3, 3, true, 300]
  ]);

  const done = events.find(e => e.type === 'done');
  assert.equal(done.synced, 3);
  assert.equal(done.failed, 0);

  // The database was actually updated per clip, not just the events emitted.
  assert.equal(db._subs.get(1).views, 100);
  assert.equal(db._subs.get(2).views, 200);
  assert.equal(db._subs.get(3).views, 300);
});

test('syncAccountClipsStream: one clip failing mid-stream does not stop or corrupt the others', async () => {
  const subs = [
    { id: 1, ig_media_id: 'ok1', last_ok_sync_at: null },
    { id: 2, ig_media_id: 'bad', last_ok_sync_at: null },
    { id: 3, ig_media_id: 'ok2', last_ok_sync_at: null }
  ];
  const db = makeTestDb(subs);
  const account = { id: 42, platform: 'instagram', access_token: 'tok', status: 'connected' };
  const fetchOne = async (id, token, { onAttempt } = {}) => {
    if (onAttempt) onAttempt();
    if (id === 'bad') throw Object.assign(new Error('boom'), { code: 'NETWORK' });
    return { ok1: 50, ok2: 70 }[id];
  };

  const progress = [];
  for await (const ev of syncAccountClipsStream(db, {}, account, subs, { fetchOne })) {
    if (ev.type === 'progress') progress.push(ev);
  }

  assert.deepEqual(progress.map(p => p.ok), [true, false, true]);
  assert.equal(db._subs.get(1).views, 50);
  assert.equal(db._subs.get(2).sync_error, 'NETWORK');
  assert.equal(db._subs.get(3).views, 70, 'clip after the failure still updates normally');
});

test('syncAccountClipsStream: emits a single blocked event and yields nothing else for 500 active clips', async () => {
  const subs = Array.from({ length: 500 }, (_, i) => ({ id: i, ig_media_id: `m${i}`, last_ok_sync_at: null }));
  const db = makeTestDb(subs);
  const account = { id: 42, platform: 'instagram', access_token: 'tok', status: 'connected' };
  let calls = 0;
  const fetchOne = async () => { calls++; return 1; };

  const events = [];
  for await (const ev of syncAccountClipsStream(db, {}, account, subs, { fetchOne })) events.push(ev);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'blocked');
  assert.equal(events[0].reason, 'TOO_MANY_ACTIVE_CLIPS');
  assert.equal(events[0].eligible, 500);
  assert.equal(calls, 0, 'not a single network call is made when hard-blocked');
});

test('syncAccountClipsStream: real calls made match exactly the number of clips attempted', async () => {
  const subs = Array.from({ length: 7 }, (_, i) => ({ id: i, ig_media_id: `m${i}`, last_ok_sync_at: null }));
  const db = makeTestDb(subs);
  const account = { id: 55, platform: 'instagram', access_token: 'tok', status: 'connected' };
  let calls = 0;
  // A real fetchOne (instagram.js's fetchMediaViews) reports its own attempt
  // via onAttempt at the actual HTTP layer -- the fake must do the same to
  // accurately stand in for it, rather than silently skipping that contract.
  const fetchOne = async (id, token, { onAttempt } = {}) => { calls++; if (onAttempt) onAttempt(); return 42; };

  for await (const _ of syncAccountClipsStream(db, {}, account, subs, { fetchOne })) { /* drain */ }

  assert.equal(calls, 7);
  const logged = db._tables.ig_api_calls.filter(r => r.social_account_id === 55).length;
  assert.equal(logged, 7, 'budget ledger reflects exactly the calls actually made');
});
