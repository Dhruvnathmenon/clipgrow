// A refresh job whose invocation died mid-run stayed 'running' forever.
//
// The partial unique indexes in migration 017 key on status IN
// ('queued','running'), so that dead row blocked EVERY later global refresh:
// createRefreshJob hit the constraint and returned 409, and the 6-hourly cron
// just logged "[cron sync] skipped" and returned -- quietly doing nothing,
// every six hours, indefinitely, while views stopped updating platform-wide
// and earnings silently froze. Nothing in the codebase ever wrote 'failed',
// and `refresh_jobs.error` was never set to a non-NULL value anywhere, so
// nothing ever cleared it. There was no reaper, no timeout and no cancel.
//
// The dead job also kept its accounts locked, because claimAccount only steals
// active_job_id from a job that is NOT active.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { reapStalledJobs, REAP_AFTER_MS, claimAccount } from '../src/refresh-jobs.js';

const NOW = Date.now();
const LONG_AGO = NOW - REAP_AFTER_MS - 60_000;   // comfortably past the cutoff
const JUST_NOW = NOW - 60_000;                   // alive

function seed(jobs, accounts = []) {
  return makeSqliteD1({
    clippers: [
      { id: 1, username: 'c', password_hash: 'h', password_salt: 's', created_at: NOW },
      { id: 2, username: 'd', password_hash: 'h', password_salt: 's', created_at: NOW }
    ],
    social_accounts: accounts,
    refresh_jobs: jobs
  });
}

const job = (o = {}) => ({
  id: 1, kind: 'global', clipper_id: null, triggered_by: 'cron', respect_cooldown: 1,
  status: 'running', pending_json: '[]', invocations: 1,
  clips_fetched: 0, clips_failed: 0, clips_skipped: 0, imported: 0,
  accounts_json: '{}', error: null,
  created_at: LONG_AGO, updated_at: LONG_AGO, finished_at: null, ...o
});

const account = (o = {}) => ({
  id: 10, clipper_id: 1, platform: 'instagram', external_id: 'ig10', username: 'h',
  account_type: 'BUSINESS', access_token: 't', status: 'connected',
  connected_at: NOW, auto_import: 1, ...o
});

test('a job abandoned mid-run is failed and its reason recorded', async () => {
  const db = seed([job()]);

  const reaped = await reapStalledJobs(db, { now: NOW });

  assert.deepEqual(reaped, [1]);
  const row = db._rows('refresh_jobs')[0];
  assert.equal(row.status, 'failed');
  assert.match(row.error, /Abandoned/, 'refresh_jobs.error was a permanently dead column before this');
  assert.equal(row.finished_at, NOW);
});

test('reaping releases the accounts the dead job was still holding', async () => {
  const db = seed([job()], [account({ active_job_id: 1 })]);

  await reapStalledJobs(db, { now: NOW });

  assert.equal(db._rows('social_accounts')[0].active_job_id, null);
});

test('after reaping, a new job can claim the account the dead one held', async () => {
  // This is the end-to-end symptom: until the dead row is cleared, nothing new
  // can touch that account, so its clips never sync again.
  const db = seed([job()], [account({ active_job_id: 1 })]);

  await reapStalledJobs(db, { now: NOW });
  const claimed = await claimAccount(db, 10, 2);

  assert.equal(claimed, true);
  assert.equal(db._rows('social_accounts')[0].active_job_id, 2);
});

test('a job that is still making progress is left alone', async () => {
  const db = seed([job({ updated_at: JUST_NOW })]);

  const reaped = await reapStalledJobs(db, { now: NOW });

  assert.deepEqual(reaped, []);
  assert.equal(db._rows('refresh_jobs')[0].status, 'running');
});

test('a finished job is never touched', async () => {
  const db = seed([job({ status: 'done', finished_at: LONG_AGO })]);

  const reaped = await reapStalledJobs(db, { now: NOW });

  assert.deepEqual(reaped, []);
  assert.equal(db._rows('refresh_jobs')[0].status, 'done');
  assert.equal(db._rows('refresh_jobs')[0].error, null);
});

test('a queued job that never started is reaped too', async () => {
  // 'queued' counts toward the same unique index, so a job that was created
  // but whose first chunk never ran blocks everything exactly as a 'running'
  // one does.
  const db = seed([job({ status: 'queued' })]);

  assert.deepEqual(await reapStalledJobs(db, { now: NOW }), [1]);
  assert.equal(db._rows('refresh_jobs')[0].status, 'failed');
});

test('several dead jobs are all cleared in one pass', async () => {
  // Note the shapes: migration 017 allows only ONE active global job and one
  // active job per clipper, so this is the full set of rows that can coexist.
  const db = seed([
    job({ id: 1 }),
    job({ id: 2, kind: 'clipper', clipper_id: 1 }),
    job({ id: 3, kind: 'clipper', clipper_id: 2, updated_at: JUST_NOW })
  ]);

  const reaped = await reapStalledJobs(db, { now: NOW });

  assert.deepEqual(reaped.sort(), [1, 2]);
  assert.equal(db._rows('refresh_jobs').find(r => r.id === 3).status, 'running', 'the live one survives');
});
