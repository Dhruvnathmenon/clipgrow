// The chained refresh engine.
//
// This exists because Cloudflare caps EXTERNAL subrequests per invocation and
// a full sweep exceeds it -- confirmed in production, where the accounts last
// in the loop came back carrying sync_error = 'SUBREQUEST_LIMIT'. These tests
// pin the behaviours that make chaining safe rather than merely working:
// nothing already-paid is ever overwritten, no item can loop forever, and one
// broken account never takes the rest of the job down with it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runChunk, buildAccountItems, claimAccount, CALLS_PER_INVOCATION
} from '../src/refresh-jobs.js';

const HOUR = 60 * 60 * 1000;

/* A D1 stand-in covering exactly the queries the engine issues. Submissions
   and accounts are real mutable rows so guarded writes can be observed. */
function makeDb({ job, submissions = [], accounts = [], igCalls = [] } = {}) {
  const state = {
    job: { id: 1, status: 'queued', pending_json: '[]', invocations: 0, clips_fetched: 0,
           clips_failed: 0, clips_skipped: 0, imported: 0, accounts_json: null, ...job },
    submissions: submissions.map(s => ({ ...s })),
    accounts: accounts.map(a => ({ ...a })),
    igCalls: [...igCalls]
  };

  function run(sql, a) {
    if (/^UPDATE refresh_jobs SET status = 'running'/.test(sql)) {
      state.job.status = 'running'; state.job.invocations++; return { meta: { changes: 1 } };
    }
    if (/^UPDATE refresh_jobs SET pending_json/.test(sql)) {
      const [pending, fetched, failed, skipped, imported, acctJson, status, ts, fin] = a;
      Object.assign(state.job, { pending_json: pending, clips_fetched: fetched, clips_failed: failed,
        clips_skipped: skipped, imported, accounts_json: acctJson, status, updated_at: ts, finished_at: fin });
      return { meta: { changes: 1 } };
    }
    if (/^UPDATE social_accounts SET active_job_id = \?\s+WHERE id/.test(sql)) {
      const [jobId, accountId] = a;
      const acct = state.accounts.find(x => x.id === accountId);
      if (!acct) return { meta: { changes: 0 } };
      const held = acct.active_job_id;
      const freeable = held == null || held === jobId ||
        !(held === state.job.id && ['queued', 'running'].includes(state.job.status));
      if (!freeable) return { meta: { changes: 0 } };
      acct.active_job_id = jobId;
      return { meta: { changes: 1 } };
    }
    if (/^UPDATE social_accounts SET active_job_id = NULL/.test(sql)) {
      for (const acct of state.accounts) if (acct.active_job_id === a[0]) acct.active_job_id = null;
      return { meta: { changes: 1 } };
    }
    // Guarded submission writes -- the AND locked_at IS NULL is the point.
    if (/^UPDATE submissions SET views = \?/.test(sql)) {
      const [views, ls, lok, id] = a;
      const s = state.submissions.find(x => x.id === id);
      if (!s || s.locked_at != null) return { meta: { changes: 0 } };
      Object.assign(s, { views, last_synced_at: ls, last_ok_sync_at: lok, sync_error: null });
      return { meta: { changes: 1 } };
    }
    if (/^UPDATE submissions SET sync_error = \?, last_synced_at = \?/.test(sql)) {
      const [code, ls, id] = a;
      const s = state.submissions.find(x => x.id === id);
      if (!s || s.locked_at != null) return { meta: { changes: 0 } };
      Object.assign(s, { sync_error: code, last_synced_at: ls });
      return { meta: { changes: 1 } };
    }
    if (/^INSERT INTO ig_api_calls/.test(sql)) { state.igCalls.push({ social_account_id: a[0], called_at: a[1] }); return { meta: {} }; }
    if (/^DELETE FROM ig_api_calls/.test(sql)) return { meta: {} };
    throw new Error('fake-db unhandled run(): ' + sql);
  }

  function first(sql, a) {
    if (/FROM refresh_jobs WHERE id/.test(sql)) return { ...state.job };
    // loadAccount joins in the campaign this account works for, so match the
    // new query shape too and supply the fields it aliases.
    if (/FROM social_accounts/.test(sql)) {
      const acct = state.accounts.find(x => x.id === a[0]) || null;
      return acct ? { ...acct, account_id: acct.id,
                      campaign_id: acct.campaign_id == null ? 1 : acct.campaign_id,
                      allowed_platforms: acct.allowed_platforms || 'instagram,youtube' } : null;
    }
    throw new Error('fake-db unhandled first(): ' + sql);
  }

  function all(sql, a) {
    if (/SELECT id, ig_media_id, last_ok_sync_at FROM submissions/.test(sql)) {
      return { results: state.submissions.filter(s =>
        s.account_id === a[0] && s.status === 'active' && s.locked_at == null && s.eligible !== 0) };
    }
    if (/SELECT ig_media_id FROM submissions WHERE platform/.test(sql)) {
      return { results: state.submissions.filter(s => s.account_id === a[1]).map(s => ({ ig_media_id: s.ig_media_id })) };
    }
    if (/SELECT called_at FROM ig_api_calls/.test(sql)) {
      return { results: state.igCalls.filter(c => c.social_account_id === a[0] && c.called_at > a[1]) };
    }
    throw new Error('fake-db unhandled all(): ' + sql);
  }

  return {
    _state: state,
    prepare(sql) {
      let args = [];
      const st = {
        bind: (...x) => { args = x; return st; },
        run: async () => run(sql, args),
        first: async () => first(sql, args),
        all: async () => all(sql, args)
      };
      return st;
    },
    batch: async (stmts) => { const o = []; for (const s of stmts) o.push(await s.run()); return o; }
  };
}

const igAccount = (o = {}) => ({ id: 1, platform: 'instagram', username: 'ig', status: 'connected',
  access_token: 't', auto_import: 0, connected_at: 0, active_job_id: null, ...o });

const clip = (o = {}) => ({ id: 1, account_id: 1, ig_media_id: 'm1', status: 'active',
  locked_at: null, eligible: 1, views: 0, last_ok_sync_at: null, sync_error: null, ...o });

// Adapter double: one call per Instagram id, recorded via onAttempt exactly as
// the real igFetch does at the HTTP layer.
function igAdapter(viewsById, onFetch) {
  return {
    instagram: {
      fetchViews: async (account, ids, env, { onAttempt } = {}) => {
        const map = new Map();
        for (const id of ids) {
          if (onAttempt) onAttempt();
          if (onFetch) onFetch(id);
          const v = viewsById[id];
          map.set(id, v === undefined ? undefined : (v && v.err ? { ok: false, code: v.err } : { ok: true, views: v }));
        }
        return map;
      },
      listRecent: async () => []
    }
  };
}

/* ─────────────────────────────── tests ─────────────────────────────── */

test('runChunk: stops at the per-invocation call budget and leaves the rest pending', async () => {
  const total = CALLS_PER_INVOCATION + 15;
  const subs = Array.from({ length: total }, (_, i) => clip({ id: i + 1, ig_media_id: 'm' + (i + 1) }));
  const views = {}; subs.forEach(s => { views[s.ig_media_id] = 100; });
  const pending = subs.map(s => ({ t: 'ig_view', a: 1, s: s.id, m: s.ig_media_id }));

  let fetches = 0;
  const db = makeDb({ job: { pending_json: JSON.stringify(pending) }, submissions: subs, accounts: [igAccount()] });
  const r = await runChunk(db, {}, 1, { adapters: igAdapter(views, () => fetches++) });

  assert.equal(r.done, false, 'work remains');
  assert.equal(fetches, CALLS_PER_INVOCATION, 'never exceeds the invocation budget');
  assert.equal(r.remaining, 15, 'the untouched remainder is preserved for the next invocation');
  assert.equal(r.enqueue, true, 'caller is told to enqueue a continuation');
});

test('runChunk: chained invocations eventually complete the whole job with no double-fetching', async () => {
  const total = CALLS_PER_INVOCATION + 15;
  const subs = Array.from({ length: total }, (_, i) => clip({ id: i + 1, ig_media_id: 'm' + (i + 1) }));
  const views = {}; subs.forEach(s => { views[s.ig_media_id] = 500; });
  const pending = subs.map(s => ({ t: 'ig_view', a: 1, s: s.id, m: s.ig_media_id }));

  const seen = [];
  const db = makeDb({ job: { pending_json: JSON.stringify(pending) }, submissions: subs, accounts: [igAccount()] });
  const adapters = igAdapter(views, id => seen.push(id));

  let guard = 0, res;
  do { res = await runChunk(db, {}, 1, { adapters }); } while (!res.done && ++guard < 10);

  assert.equal(res.done, true, 'job finishes across invocations');
  assert.equal(seen.length, total, 'every clip fetched exactly once in total');
  assert.equal(new Set(seen).size, total, 'no clip is fetched twice across the handoff');
  assert.equal(db._state.submissions.every(s => s.views === 500), true, 'all views written');
  assert.equal(db._state.job.status, 'done');
});

test('runChunk: a clip locked (paid) between snapshot and its turn is never overwritten', async () => {
  const subs = [clip({ id: 1, ig_media_id: 'm1' }), clip({ id: 2, ig_media_id: 'm2', views: 1234 })];
  const pending = subs.map(s => ({ t: 'ig_view', a: 1, s: s.id, m: s.ig_media_id }));
  const db = makeDb({ job: { pending_json: JSON.stringify(pending) }, submissions: subs, accounts: [igAccount()] });

  // Clip 2 gets paid and locked after the work list was built.
  db._state.submissions[1].locked_at = Date.now();
  db._state.submissions[1].locked_earning = 1234;

  const r = await runChunk(db, {}, 1, { adapters: igAdapter({ m1: 10, m2: 999999 }) });

  assert.equal(db._state.submissions[1].views, 1234, 'settled clip keeps its frozen view count');
  assert.equal(db._state.submissions[1].locked_earning, 1234, 'settled money untouched');
  assert.equal(r.stats.skipped, 1, 'counted as skipped, not as a success or a failure');
  assert.equal(db._state.submissions[0].views, 10, 'the unlocked clip still updates normally');
});

test('runChunk: a failing clip is popped, not retried forever', async () => {
  const subs = [clip({ id: 1, ig_media_id: 'bad' }), clip({ id: 2, ig_media_id: 'good' })];
  const pending = subs.map(s => ({ t: 'ig_view', a: 1, s: s.id, m: s.ig_media_id }));
  const db = makeDb({ job: { pending_json: JSON.stringify(pending) }, submissions: subs, accounts: [igAccount()] });

  const r = await runChunk(db, {}, 1, { adapters: igAdapter({ bad: { err: 'NETWORK' }, good: 42 }) });

  assert.equal(r.done, true, 'job completes rather than stalling on the bad item');
  assert.equal(JSON.parse(db._state.job.pending_json).length, 0, 'the failing item was removed from the list');
  assert.equal(db._state.submissions[0].sync_error, 'NETWORK');
  assert.equal(db._state.submissions[1].views, 42, 'the healthy clip after it still processed');
});

test('runChunk: an account disconnected mid-job has its work skipped, not failed', async () => {
  const subs = [clip({ id: 1, ig_media_id: 'm1' })];
  const pending = [{ t: 'ig_view', a: 1, s: 1, m: 'm1' }];
  const db = makeDb({ job: { pending_json: JSON.stringify(pending) }, submissions: subs,
    accounts: [igAccount({ status: 'revoked' })] });

  const r = await runChunk(db, {}, 1, { adapters: igAdapter({ m1: 5 }) });

  assert.equal(r.done, true);
  assert.equal(r.stats.skipped, 1, 'skipped -- nothing is wrong with the clip itself');
  assert.equal(r.stats.failed, 0, 'not reported as a clip failure');
});

// planInstagramSync (earnings.js) already refuses to queue more than an
// account's remaining 200/hour Instagram budget for the clipper-triggered
// sync -- this queue-based path (every admin/cron refresh) had no equivalent
// check, so once an account's real Instagram budget ran out it queued every
// due clip anyway and Instagram's own per-clip rejection did the job. Exactly
// what several manual "Refresh views first" clicks for the same clipper
// during a payout run walks into.
test('runChunk: an account whose Instagram budget is already used up gets its items deferred, not spent against a rejection', async () => {
  const NOW = Date.now();
  // 200 calls already made within the rolling hour -- nothing left to spend.
  const igCalls = Array.from({ length: 200 }, (_, i) => ({ social_account_id: 1, called_at: NOW - 1000 - i }));
  const subs = [clip({ id: 1, ig_media_id: 'm1' }), clip({ id: 2, ig_media_id: 'm2' })];
  const pending = subs.map(s => ({ t: 'ig_view', a: 1, s: s.id, m: s.ig_media_id }));
  const db = makeDb({ job: { pending_json: JSON.stringify(pending) }, submissions: subs, accounts: [igAccount()], igCalls });

  let fetches = 0;
  const r = await runChunk(db, {}, 1, { adapters: igAdapter({ m1: 111, m2: 222 }, () => fetches++) });

  assert.equal(fetches, 0, 'the adapter is never called -- no call is spent on a rejection we can already predict');
  assert.equal(r.done, false, 'the job is not finished -- deferred, not dropped');
  assert.equal(JSON.parse(db._state.job.pending_json).length, 2, 'both items remain queued for a later invocation');
  assert.equal(db._state.submissions[0].views, 0, 'views untouched, not overwritten with a failure');
  assert.equal(db._state.submissions[0].sync_error, null, 'not marked as a per-clip failure either');
});

test('runChunk: an account with some budget left still gets exactly that much done, no more', async () => {
  const NOW = Date.now();
  // 198 of 200 used -- exactly 2 calls remain in the rolling window.
  const igCalls = Array.from({ length: 198 }, (_, i) => ({ social_account_id: 1, called_at: NOW - 1000 - i }));
  const subs = [clip({ id: 1, ig_media_id: 'm1' }), clip({ id: 2, ig_media_id: 'm2' }), clip({ id: 3, ig_media_id: 'm3' })];
  const pending = subs.map(s => ({ t: 'ig_view', a: 1, s: s.id, m: s.ig_media_id }));
  const db = makeDb({ job: { pending_json: JSON.stringify(pending) }, submissions: subs, accounts: [igAccount()], igCalls });

  const r = await runChunk(db, {}, 1, { adapters: igAdapter({ m1: 10, m2: 20, m3: 30 }) });

  assert.equal(db._state.submissions[0].views, 10);
  assert.equal(db._state.submissions[1].views, 20);
  assert.equal(db._state.submissions[2].views, 0, 'the third clip is deferred once the two remaining calls are spent');
  assert.equal(JSON.parse(db._state.job.pending_json).length, 1);
});

test('claimAccount: a second job cannot take an account already held by a live job', async () => {
  const db = makeDb({ job: { id: 1, status: 'running' }, accounts: [igAccount({ active_job_id: null })] });
  assert.equal(await claimAccount(db, 1, 1), true, 'first job claims it');
  assert.equal(await claimAccount(db, 1, 2), false, 'a different live job is refused');
  assert.equal(await claimAccount(db, 1, 1), true, 'the holder can re-claim its own lock');
});

test('claimAccount: a lock left behind by a finished job is taken over, not respected forever', async () => {
  const db = makeDb({ job: { id: 1, status: 'done' }, accounts: [igAccount({ active_job_id: 1 })] });
  assert.equal(await claimAccount(db, 1, 2), true, 'a dead job never blocks an account permanently');
  assert.equal(db._state.accounts[0].active_job_id, 2);
});

test('buildAccountItems: cooldown is respected for cron and ignored for a human refresh', async () => {
  const now = Date.now();
  const subs = [
    clip({ id: 1, ig_media_id: 'fresh', last_ok_sync_at: now - 10 * 60 * 1000 }),
    clip({ id: 2, ig_media_id: 'stale', last_ok_sync_at: now - 2 * HOUR }),
    clip({ id: 3, ig_media_id: 'never', last_ok_sync_at: null })
  ];
  const db = makeDb({ submissions: subs, accounts: [igAccount()] });
  const acct = { account_id: 1, platform: 'instagram', auto_import: 0 };

  const cron = await buildAccountItems(db, acct, { respectCooldown: true });
  assert.deepEqual(cron.map(i => i.m).sort(), ['never', 'stale'], 'cron skips the recently-checked clip');

  const human = await buildAccountItems(db, acct, { respectCooldown: false });
  assert.equal(human.length, 3, 'a human full refresh checks every eligible clip');
});

test('buildAccountItems: YouTube batches 50 clips per call instead of one item each', async () => {
  const subs = Array.from({ length: 120 }, (_, i) => clip({ id: i + 1, account_id: 2, ig_media_id: 'v' + i }));
  const db = makeDb({ submissions: subs, accounts: [igAccount({ id: 2, platform: 'youtube' })] });
  const items = await buildAccountItems(db, { account_id: 2, platform: 'youtube', auto_import: 0 }, { respectCooldown: false });

  assert.equal(items.length, 3, '120 clips -> 3 batched calls, not 120');
  assert.equal(items[0].s.length, 50);
  assert.equal(items[2].s.length, 20);
});

test('buildAccountItems: a paste-only account gets no import item', async () => {
  const db = makeDb({ submissions: [], accounts: [igAccount()] });
  const auto = await buildAccountItems(db, { account_id: 1, platform: 'instagram', auto_import: 1 }, {});
  const paste = await buildAccountItems(db, { account_id: 1, platform: 'instagram', auto_import: 0 }, {});
  assert.equal(auto.filter(i => i.t === 'import').length, 1);
  assert.equal(paste.filter(i => i.t === 'import').length, 0, 'paste-only accounts are never auto-imported');
});

test('runChunk: calls actually spent are written to the shared budget ledger', async () => {
  const subs = Array.from({ length: 5 }, (_, i) => clip({ id: i + 1, ig_media_id: 'm' + i }));
  const views = {}; subs.forEach(s => { views[s.ig_media_id] = 7; });
  const pending = subs.map(s => ({ t: 'ig_view', a: 1, s: s.id, m: s.ig_media_id }));
  const db = makeDb({ job: { pending_json: JSON.stringify(pending) }, submissions: subs, accounts: [igAccount()] });

  await runChunk(db, {}, 1, { adapters: igAdapter(views) });

  assert.equal(db._state.igCalls.length, 5,
    'the ledger the UI reads reflects what this job really spent, not an estimate');
});
