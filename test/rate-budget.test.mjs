// Proves the actual Instagram rate-budget math, not just that it compiles.
// This is the logic that stands between the app and repeatedly tripping
// Instagram's real 200-calls/hour-per-account limit, so it gets the same
// rigor as the sync-isolation fix: real assertions against real code, using
// a lightweight fake D1 rather than mocks of the module under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeD1 } from './helpers/fake-d1.mjs';
import { getBudget, makeCallCounter, HOURLY_LIMIT, CLIP_COOLDOWN_MS } from '../src/rate-budget.js';
import { planInstagramSync } from '../src/earnings.js';

test('getBudget: empty account has the full limit available', async () => {
  const db = makeFakeD1();
  const budget = await getBudget(db, 1);
  assert.equal(budget.used, 0);
  assert.equal(budget.remaining, HOURLY_LIMIT);
  assert.equal(budget.reset_in_ms, 0);
});

test('getBudget: only counts calls within the rolling 60-minute window', async () => {
  const db = makeFakeD1();
  const now = Date.now();
  // 3 calls inside the window, 2 calls that have already aged out.
  db._tables.ig_api_calls.push(
    { id: 1, social_account_id: 5, called_at: now - 10 * 60 * 1000 },
    { id: 2, social_account_id: 5, called_at: now - 30 * 60 * 1000 },
    { id: 3, social_account_id: 5, called_at: now - 59 * 60 * 1000 },
    { id: 4, social_account_id: 5, called_at: now - 61 * 60 * 1000 },   // aged out
    { id: 5, social_account_id: 5, called_at: now - 90 * 60 * 1000 }    // aged out
  );

  const budget = await getBudget(db, 5);
  assert.equal(budget.used, 3);
  assert.equal(budget.remaining, HOURLY_LIMIT - 3);
});

test('getBudget: reset_in_ms counts down to the OLDEST call aging out, not a fixed clock hour', async () => {
  const db = makeFakeD1();
  const now = Date.now();
  const oldestAgeMs = 45 * 60 * 1000; // called 45 minutes ago
  db._tables.ig_api_calls.push({ id: 1, social_account_id: 9, called_at: now - oldestAgeMs });

  const budget = await getBudget(db, 9);
  // Should free up in roughly 60 - 45 = 15 minutes, not reset to a clean hour.
  const expectedMs = 15 * 60 * 1000;
  assert.ok(Math.abs(budget.reset_in_ms - expectedMs) < 2000, `expected ~${expectedMs}ms, got ${budget.reset_in_ms}ms`);
});

test('getBudget never goes negative when usage exceeds the limit', async () => {
  const db = makeFakeD1();
  const now = Date.now();
  for (let i = 0; i < HOURLY_LIMIT + 20; i++) {
    db._tables.ig_api_calls.push({ id: i, social_account_id: 2, called_at: now - i * 1000 });
  }
  const budget = await getBudget(db, 2);
  assert.equal(budget.used, HOURLY_LIMIT + 20);
  assert.equal(budget.remaining, 0);
});

test('makeCallCounter: buffers in memory and writes once via db.batch, not per call', async () => {
  const db = makeFakeD1();
  const counter = makeCallCounter(7);
  counter.onAttempt(); counter.onAttempt(); counter.onAttempt();
  assert.equal(counter.count(), 3);
  assert.equal(db._tables.ig_api_calls.length, 0, 'nothing written until flush');

  await counter.flush(db);
  assert.equal(db._tables.ig_api_calls.length, 3);
  assert.equal(counter.count(), 0, 'buffer cleared after flush');
});

// ----------------------------------------------------- planInstagramSync

test('planInstagramSync: a channel with 500 active clips is hard-refused, not partially synced', async () => {
  const db = makeFakeD1();
  const subs = Array.from({ length: 500 }, (_, i) => ({ id: i, ig_media_id: `m${i}`, last_ok_sync_at: null }));

  const plan = await planInstagramSync(db, 1, subs);
  assert.equal(plan.blocked, 'TOO_MANY_ACTIVE_CLIPS');
  assert.equal(plan.attempt.length, 0, 'nothing is attempted, not a partial batch');
  assert.equal(plan.eligible, 500);
});

test('planInstagramSync: exactly 200 eligible clips with a full budget all get attempted', async () => {
  const db = makeFakeD1();
  const subs = Array.from({ length: 200 }, (_, i) => ({ id: i, ig_media_id: `m${i}`, last_ok_sync_at: null }));

  const plan = await planInstagramSync(db, 1, subs);
  assert.equal(plan.blocked, null);
  assert.equal(plan.attempt.length, 200);
});

test('planInstagramSync: a clip synced within the last hour is skipped, not re-fetched', async () => {
  const db = makeFakeD1();
  const now = Date.now();
  const subs = [
    { id: 1, ig_media_id: 'fresh', last_ok_sync_at: now - 10 * 60 * 1000 },   // 10 min ago -- still fresh
    { id: 2, ig_media_id: 'stale', last_ok_sync_at: now - 90 * 60 * 1000 },   // 90 min ago -- eligible again
    { id: 3, ig_media_id: 'never', last_ok_sync_at: null }                   // never synced -- eligible
  ];

  const plan = await planInstagramSync(db, 1, subs);
  const attemptedIds = plan.attempt.map(s => s.ig_media_id);
  assert.deepEqual(attemptedIds.sort(), ['never', 'stale']);
});

test('planInstagramSync: with only partial budget left, attempts exactly that many and marks the rest deferred', async () => {
  const db = makeFakeD1();
  const now = Date.now();
  // Burn 195 of the 200-call budget already this hour.
  for (let i = 0; i < 195; i++) db._tables.ig_api_calls.push({ id: i, social_account_id: 3, called_at: now - i * 1000 });

  const subs = Array.from({ length: 20 }, (_, i) => ({ id: i, ig_media_id: `m${i}`, last_ok_sync_at: null }));
  const plan = await planInstagramSync(db, 3, subs);

  assert.equal(plan.attempt.length, 5, 'only the 5 remaining calls worth are attempted');
  assert.equal(plan.deferred, 15);
  assert.equal(plan.blocked, null, 'partial progress is not the same as fully blocked');
});

test('planInstagramSync: zero remaining budget blocks with BUDGET_EXHAUSTED, distinct from too-many-clips', async () => {
  const db = makeFakeD1();
  const now = Date.now();
  for (let i = 0; i < HOURLY_LIMIT; i++) db._tables.ig_api_calls.push({ id: i, social_account_id: 4, called_at: now - i * 1000 });

  const subs = [{ id: 1, ig_media_id: 'm1', last_ok_sync_at: null }];
  const plan = await planInstagramSync(db, 4, subs);

  assert.equal(plan.blocked, 'BUDGET_EXHAUSTED');
  assert.equal(plan.attempt.length, 0);
});
