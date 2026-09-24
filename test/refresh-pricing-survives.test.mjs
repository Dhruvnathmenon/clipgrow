// 24 Sep 2026: for 14 hourly runs in a row, the refresh job was killed part-way and
// nothing was priced. A clip that had just been imported sat at Rs 0 while its views
// climbed past 10,000, under a message saying the campaign's budget had run out --
// on a campaign with about Rs 3,900 unallocated.
//
// Cause: Cloudflare counts every D1 query as a subrequest, wrangler.jsonc pinned the
// limit at 1,000, and one chunk of ~140 clips plus 84 accounts costs about that many
// queries. The invocation was cut off mid-item, so it never wrote its final state,
// never queued its continuation, and never reached the one place prices were
// recomputed (the very end of a finished job).
//
// These tests give the real runner a database that enforces a per-invocation ceiling
// the way Cloudflare does, so the failure is reproduced rather than assumed, and then
// show what keeps a run from ever meeting it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { wrapD1 } from '../src/d1-usage.js';
import { createRefreshJob, advanceJob, getJob, SUBREQUEST_BUDGET } from '../src/refresh-jobs.js';
import { refreshHooks } from '../src/refresh-hooks.js';
import { reallocateAll } from '../src/earnings.js';
import { explainEarning, explainEarningText } from '../src/earning-math.js';
import { budgetLeftByCampaign } from '../src/db.js';

const NOW = Date.now();
const CPM = 50;

/** A world of `accounts` Instagram accounts with `perAccount` fresh clips each, one campaign. */
function world({ accounts, perAccount, budget = 10_000_000, extraSubs = [] }) {
  const clippers = [], social = [], parts = [], links = [], subs = [];
  let subId = 1;
  for (let i = 1; i <= accounts; i++) {
    clippers.push({ id: i, username: `clipper${i}`, password_hash: 'h', password_salt: 's', created_at: NOW });
    social.push({ id: 100 + i, clipper_id: i, platform: 'instagram', external_id: `ig${i}`, username: `h${i}`,
                  account_type: 'BUSINESS', access_token: 'tok', status: 'connected', connected_at: NOW - 86_400_000, auto_import: 0 });
    parts.push({ id: 1000 + i, clipper_id: i, campaign_id: 1, status: 'active', joined_at: NOW, account_id: 100 + i });
    links.push({ id: 5000 + i, participation_id: 1000 + i, account_id: 100 + i, platform: 'instagram', linked_at: NOW });
    for (let k = 0; k < perAccount; k++, subId++) {
      subs.push({ id: subId, clipper_id: i, campaign_id: 1, account_id: 100 + i, platform: 'instagram',
                  ig_media_id: `m${subId}`, permalink: `p${subId}`, views: 0, earning: 0, clipper_earning: 0,
                  status: 'active', eligible: 1, created_at: NOW - 60_000 + subId, posted_at: NOW - 60_000, source: 'auto' });
    }
  }
  return makeSqliteD1({
    clippers,
    campaigns: [{ id: 1, name: 'Mali', cpm: CPM, budget, status: 'active', created_at: NOW, min_views: 1000, allowed_platforms: 'instagram' }],
    social_accounts: social, participations: parts, participation_accounts: links,
    submissions: [...subs, ...extraSubs]
  });
}

/** Cloudflare's rule, enforced: past `ceiling` subrequests the invocation gets an exception, not a result. */
function withCeiling(db, ceiling) {
  let used = 0;
  const hit = (n = 1) => { used += n; if (used > ceiling) throw new Error('Too many subrequests by single Worker invocation.'); };
  const wrap = (s) => ({
    bind: (...a) => wrap(s.bind(...a)),
    all: async () => { hit(); return s.all(); },
    first: async (...a) => { hit(); return s.first(...a); },
    run: async () => { hit(); return s.run(); },
    _exec: () => s._exec()
  });
  return { prepare: (sql) => wrap(db.prepare(sql)), batch: async (stmts) => { hit(stmts.length); return db.batch(stmts); }, _used: () => used };
}

// Every clip comes back with 2,000 views: worth Rs 100 at cpm 50, so priced clips are easy to spot.
const adapters = { instagram: {
  listRecent: async () => [],
  fetchViews: async (_a, ids) => new Map(ids.map(id => [id, { ok: true, views: 2000 }]))
} };
const queueOf = () => { const sent = []; return { sent, REFRESH_QUEUE: { send: async (m, o) => { sent.push({ m, o }); } } }; };

test('control: without the guard, a big job is cut off mid-chunk, queues nothing and prices nothing (the incident)', async () => {
  const raw = world({ accounts: 30, perAccount: 4 });             // 120 clips, 30 accounts
  const { job_id } = await createRefreshJob(raw, { kind: 'global', triggeredBy: 'test', cooldownMs: 0 });
  const q = queueOf();
  const limited = wrapD1(withCeiling(raw, 400));                   // far under what this chunk needs

  await assert.rejects(
    advanceJob(limited, { ...q }, job_id, { adapters, subrequestBudget: Infinity, ...refreshHooks(limited) }),
    /Too many subrequests/);

  assert.equal((await getJob(raw, job_id)).status, 'running', 'left half-done: the final state was never written');
  assert.equal(q.sent.length, 0, 'and no continuation was queued, so nothing will ever finish it');
  const fetched = raw._rows('submissions').filter(s => s.views > 0);
  assert.ok(fetched.length > 0, 'it did fetch views for some clips before dying');
  assert.ok(fetched.every(s => s.earning === 0), 'but not one of them was priced: earnings stayed at Rs 0 while views climbed');
});

test('with the guard, the same job stops with room to spare, hands off, and prices what it fetched', async () => {
  const raw = world({ accounts: 30, perAccount: 4 });
  const { job_id } = await createRefreshJob(raw, { kind: 'global', triggeredBy: 'test', cooldownMs: 0 });
  const q = queueOf();
  const enforced = withCeiling(raw, 400);
  const limited = wrapD1(enforced);

  // 250 leaves 150 for what a chunk still has to do after its last item.
  const r = await advanceJob(limited, { ...q }, job_id, { adapters, subrequestBudget: 250, ...refreshHooks(limited) });

  assert.equal(r.outOfRoom, true, 'it knew it was running out of room');
  assert.equal(r.done, false);
  assert.ok(enforced._used() <= 400, `stayed under the ceiling (used ${enforced._used()})`);
  assert.equal(q.sent.length, 1, 'and queued its continuation');
  assert.equal((await getJob(raw, job_id)).status, 'running');

  const fetched = raw._rows('submissions').filter(s => s.views > 0);
  assert.ok(fetched.length > 0 && fetched.length < 120, 'part of the job ran');
  assert.ok(fetched.every(s => s.earning === 100 && s.clipper_earning === 100),
    'every clip it fetched was priced in the same leg: 2,000 views at cpm 50 = Rs 100');
});

test('run leg by leg, each on a fresh budget, the whole job finishes and every clip is priced', async () => {
  const raw = world({ accounts: 30, perAccount: 4 });
  const { job_id } = await createRefreshJob(raw, { kind: 'global', triggeredBy: 'test', cooldownMs: 0 });

  let legs = 0;
  for (; legs < 30; legs++) {
    const q = queueOf();
    const limited = wrapD1(withCeiling(raw, 400));                 // a fresh invocation, a fresh ceiling
    const r = await advanceJob(limited, { ...q }, job_id, { adapters, subrequestBudget: 250, ...refreshHooks(limited) });
    if (r.done) break;
    assert.equal(q.sent.length, 1, `leg ${legs + 1} must hand off`);
  }

  assert.equal((await getJob(raw, job_id)).status, 'done');
  assert.ok(legs > 1, 'it really did need more than one leg');
  const clips = raw._rows('submissions');
  assert.equal(clips.filter(s => s.earning === 100).length, 120, 'all 120 clips priced');
});

test('prices follow views after EVERY leg, before the next is queued, even when the job is not finished', async () => {
  const raw = world({ accounts: 4, perAccount: 2 });
  const { job_id } = await createRefreshJob(raw, { kind: 'global', triggeredBy: 'test', cooldownMs: 0 });
  const order = [];
  const q = { REFRESH_QUEUE: { send: async () => { order.push('enqueue'); } } };
  const db = wrapD1(raw);

  const r = await advanceJob(db, q, job_id, {
    adapters, subrequestBudget: 25,
    afterChunk: async () => { order.push('price'); await reallocateAll(db); },
    onFinish: async () => { order.push('finish'); }
  });

  assert.equal(r.done, false);
  assert.deepEqual(order, ['price', 'enqueue'], 'priced first, then queued, and the finish hook waited for the finish');
});

test('a failure while pricing never costs the job its continuation', async () => {
  const raw = world({ accounts: 4, perAccount: 2 });
  const { job_id } = await createRefreshJob(raw, { kind: 'global', triggeredBy: 'test', cooldownMs: 0 });
  const q = queueOf();
  const db = wrapD1(raw);
  const quiet = console.error; console.error = () => {};
  try {
    const r = await advanceJob(db, { ...q }, job_id, {
      adapters, subrequestBudget: 25, afterChunk: async () => { throw new Error('D1 hiccup'); }
    });
    assert.equal(r.done, false);
    assert.equal(q.sent.length, 1, 'the continuation still went out');
  } finally { console.error = quiet; }
});

test('the guard budget stays tied to the limit wrangler.jsonc pins, with room to finish', () => {
  const m = /"subrequests"\s*:\s*(\d+)/.exec(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.ok(m, 'wrangler.jsonc must pin limits.subrequests explicitly');
  const pinned = Number(m[1]);
  assert.ok(pinned >= 10_000,
    `limits.subrequests is ${pinned}: D1 queries count against it, and 1,000 is what killed 14 runs in a row`);
  assert.ok(SUBREQUEST_BUDGET + 1500 <= pinned,
    `SUBREQUEST_BUDGET (${SUBREQUEST_BUDGET}) leaves under 1,500 of the pinned ${pinned} for the end of a chunk`);
});

// The exact case from the report. The campaign had been full; flagged clips gave budget
// back; a clip imported afterwards sat at Rs 0 and its clipper was told the budget was gone.
test('the Mali case: a new clip is priced from the freed budget, and is not told the budget ran out', async () => {
  const raw = world({ accounts: 1, perAccount: 0, budget: 15000, extraSubs: [
    // Paid history that holds most of the budget.
    { id: 1, clipper_id: 1, campaign_id: 1, account_id: 101, platform: 'instagram', ig_media_id: 'paid', permalink: 'p',
      views: 170000, earning: 8342, clipper_earning: null, status: 'active', eligible: 1, created_at: NOW - 900_000,
      posted_at: NOW - 900_000, locked_at: NOW - 800_000, locked_earning: 8342, lock_reason: 'paid' },
    // A clip that had been eating budget, since flagged: it now consumes nothing.
    { id: 2, clipper_id: 1, campaign_id: 1, account_id: 101, platform: 'instagram', ig_media_id: 'flagged', permalink: 'p2',
      views: 40281, earning: 0, clipper_earning: 0, status: 'disqualified', eligible: 1, created_at: NOW - 800_000, posted_at: NOW - 800_000 },
    // The clip from the screenshot: imported after the flag, never priced.
    { id: 3, clipper_id: 1, campaign_id: 1, account_id: 101, platform: 'instagram', ig_media_id: 'new', permalink: 'p3',
      views: 10797, earning: 0, clipper_earning: 0, status: 'active', eligible: 1, created_at: NOW - 60_000, posted_at: NOW - 60_000, source: 'auto' }
  ] });
  await raw.prepare("UPDATE campaigns SET status = 'budget_full' WHERE id = 1").run();

  // Before the fix this is exactly what the clipper saw.
  let row = await raw.prepare('SELECT * FROM submissions WHERE id = 3').first();
  let left = await budgetLeftByCampaign(raw, [1]);
  const before = explainEarning(row, { cpm: CPM, minViews: 1000, budgetLeft: left.get(1) });
  assert.equal(before.reason, 'pending_price', 'unpriced but the campaign has budget: never "ran out"');
  assert.doesNotMatch(explainEarningText(before), /budget ran out/);

  // One pricing pass (what every leg and every cron start now does).
  await reallocateAll(raw);

  row = await raw.prepare('SELECT * FROM submissions WHERE id = 3').first();
  assert.equal(row.earning, 539, '10,797 views at Rs 50 per 1,000, floored');
  assert.equal(row.clipper_earning, 539);
  assert.equal((await raw.prepare('SELECT status FROM campaigns WHERE id = 1').first()).status, 'active',
    'and the campaign is open again, because it genuinely has budget');
  left = await budgetLeftByCampaign(raw, [1]);
  assert.equal(left.get(1), 15000 - 8342 - 539);
  assert.equal(explainEarning(row, { cpm: CPM, minViews: 1000, budgetLeft: left.get(1) }).reason, 'cpm', 'fully credited: plain views x cpm');
});

// reallocateAll was a bare loop: one campaign that threw left every campaign after it
// unpriced, silently. Each is priced on its own now, and failures are reported together.
function twoCampaigns() {
  const clip = (id, campaign_id) => ({ id, clipper_id: 1, campaign_id, platform: 'instagram', ig_media_id: `m${id}`, permalink: `p${id}`,
    views: 2000, earning: 0, clipper_earning: 0, status: 'active', eligible: 1, created_at: NOW - 1000 + id, posted_at: NOW });
  return makeSqliteD1({
    clippers: [{ id: 1, username: 'sam.k', password_hash: 'h', password_salt: 's', created_at: NOW }],
    campaigns: [
      { id: 1, name: 'First', cpm: CPM, budget: 5000, status: 'active', created_at: NOW, min_views: 1000, allowed_platforms: 'instagram' },
      { id: 2, name: 'Second', cpm: CPM, budget: 5000, status: 'active', created_at: NOW, min_views: 1000, allowed_platforms: 'instagram' }
    ],
    submissions: [clip(1, 1), clip(2, 2)]
  });
}
/** A database whose pricing read for one campaign throws, as a real fault would. */
function brokenFor(db, campaignId) {
  return { ...db, prepare(sql) {
    const st = db.prepare(sql);
    if (!/FROM submissions s\s+LEFT JOIN participations/.test(sql)) return st;
    return { ...st, bind: (...a) => { if (a[0] === campaignId) throw new Error('D1_ERROR: simulated fault'); return st.bind(...a); } };
  } };
}

test('one campaign that cannot be priced does not leave the campaigns after it unpriced', async () => {
  const raw = twoCampaigns();
  await assert.rejects(reallocateAll(brokenFor(raw, 1)), /Could not re-price campaign 1/);
  assert.equal(raw._rows('submissions').find(s => s.id === 2).earning, 100, 'the healthy campaign was still priced');
  assert.equal(raw._rows('submissions').find(s => s.id === 1).earning, 0, 'the broken one was left alone, not half-written');
});

test('a pricing failure is written to the Error Log, and never stops the refresh it rides along with', async () => {
  const raw = twoCampaigns();
  const { repriceAll } = await import('../src/refresh-hooks.js');
  await repriceAll(brokenFor(raw, 1), 'cron');   // must not throw

  const logged = raw._rows('error_log');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].code, 'REPRICE_FAILED');
  assert.equal(logged[0].source, 'pricing');
  assert.match(logged[0].detail, /campaign 1/);
  assert.equal(raw._rows('submissions').find(s => s.id === 2).earning, 100);
});

// The other hidden ceiling: 15 minutes of wall time per scheduled run or queue leg.
test('a leg that has used its time budget stops before the next item, hands off and prices', async () => {
  const raw = world({ accounts: 6, perAccount: 2 });
  const { job_id } = await createRefreshJob(raw, { kind: 'global', triggeredBy: 'test', cooldownMs: 0 });
  const q = queueOf();
  const db = wrapD1(raw);

  // A zero time budget means "already out of time": nothing new may start.
  const r = await advanceJob(db, { ...q }, job_id, { adapters, wallBudgetMs: 0, ...refreshHooks(db) });

  assert.equal(r.outOfRoom, true);
  assert.equal(r.itemsDone, 0);
  assert.equal(q.sent.length, 1, 'still hands off');
  assert.deepEqual(q.sent[0].o, { delaySeconds: 60 }, 'and waits a minute rather than spinning, since it did nothing');
  assert.equal((await getJob(raw, job_id)).status, 'running');
});

test('the wall-time budget leaves five minutes of the fifteen for the end of a leg', async () => {
  const { WALL_BUDGET_MS } = await import('../src/refresh-jobs.js');
  assert.ok(WALL_BUDGET_MS <= 10 * 60 * 1000, 'Cloudflare cuts a scheduled run or queue leg off at 15 minutes');
});
