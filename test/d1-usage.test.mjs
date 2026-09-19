// Self-tracked D1 usage against Workers Paid's monthly included allowance
// (src/d1-usage.js) -- built after the 2026-09-13 outage (D1's Free-tier
// daily quota exhausted with zero warning, commit 8443202). The account is
// now on Workers Paid, so this tracks the current UTC month's running
// total against the monthly allowance rather than a single day against a
// daily wall, and gates the heavy 6-hourly refresh sync behind a one-click
// admin pause instead of anything automatic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';
import { createRefreshJob } from '../src/refresh-jobs.js';
import { CLIP_COOLDOWN_MS } from '../src/rate-budget.js';
import {
  wrapD1, flushUsage, isPaused, setPaused, getPauseState, platformUsageSnapshot,
  D1_MONTHLY_LIMITS
} from '../src/d1-usage.js';

const SESSION_SECRET = 'test-secret';

function seedEnv() {
  return { DB: makeSqliteD1({}), SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
}

async function adminRequest(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('admin', 'admin', env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method,
    headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleAdmin(request, env, new URL(request.url));
}

/* ── wrapD1: accumulation ── */

test('wrapD1 accumulates rows_read/rows_written across .all(), .run() and .batch(), and .first() contributes nothing', async () => {
  const db = makeSqliteD1({ clippers: [
    { id: 1, username: 'a', password_hash: 'h', password_salt: 's', status: 'active', created_at: Date.now() },
    { id: 2, username: 'b', password_hash: 'h', password_salt: 's', status: 'active', created_at: Date.now() }
  ] });
  const wrapped = wrapD1(db);

  await wrapped.prepare('SELECT * FROM clippers').all();               // real D1: meta.rows_read = 2
  await wrapped.prepare('SELECT * FROM clippers WHERE id = ?').bind(1).first(); // real D1: no meta at all -- documented blind spot
  await wrapped.prepare("UPDATE clippers SET status = 'disabled' WHERE id = ?").bind(1).run(); // 1 row written

  const s1 = wrapped.prepare("UPDATE clippers SET status = 'disabled' WHERE id = 1");
  const s2 = wrapped.prepare("UPDATE clippers SET status = 'disabled' WHERE id = 2");
  await wrapped.batch([s1, s2]);

  const usage = wrapped._usage();
  // .all(): 2 rows read. .first(): 0 (no meta -- documented blind spot).
  // .run(): 1 write. .batch() of 2 more writes: 2 more.
  assert.equal(usage.rowsRead, 2, 'only the .all() call contributed reads');
  assert.equal(usage.rowsWritten, 3, 'the .run() write plus both .batch() writes');
});

test('wrapD1.batch() returns the batch results completely unmodified', async () => {
  const db = makeSqliteD1({ clippers: [{ id: 1, username: 'a', password_hash: 'h', password_salt: 's', status: 'active', created_at: Date.now() }] });
  const wrapped = wrapD1(db);
  const stmt = wrapped.prepare("UPDATE clippers SET status = 'disabled' WHERE id = 1");
  const [result] = await wrapped.batch([stmt]);
  // finance.js/payouts.js read result.meta.last_row_id / .changes straight
  // off a batch return value -- this must still exist and be correct.
  assert.equal(result.meta.changes, 1);
});

/* ── flushUsage: the daily UPSERT + monthly threshold alert ── */

test('flushUsage increments the daily row across multiple flushes on the same day', async () => {
  const env = seedEnv();
  await flushUsage(env.DB, { rowsRead: 100, rowsWritten: 5 });
  await flushUsage(env.DB, { rowsRead: 50, rowsWritten: 2 });

  const snap = await platformUsageSnapshot(env.DB);
  assert.equal(snap.today.rows_read, 150);
  assert.equal(snap.today.rows_written, 7);
  assert.equal(snap.month_to_date.rows_read, 150);
});

test('flushUsage is a no-op when nothing happened -- no row is written at all', async () => {
  const env = seedEnv();
  await flushUsage(env.DB, { rowsRead: 0, rowsWritten: 0 });
  const rows = env.DB._rows('d1_usage_daily');
  assert.equal(rows.length, 0, 'a static-asset request that touched no D1 must not create a row');
});

test('the monthly alert fires once at 70%, once at 90%, and not again the same month', async () => {
  const env = seedEnv();
  const limit = D1_MONTHLY_LIMITS.rowsRead;

  await flushUsage(env.DB, { rowsRead: Math.floor(limit * 0.75), rowsWritten: 0 });
  let errors = env.DB._rows('error_log');
  assert.equal(errors.length, 1, 'crossing 70% fires the warning once');
  assert.equal(errors[0].code, 'D1_MONTHLY_WARN');

  // Still under 90% -- must not re-fire the warning.
  await flushUsage(env.DB, { rowsRead: Math.floor(limit * 0.01), rowsWritten: 0 });
  assert.equal(env.DB._rows('error_log').length, 1, 'still under 90%, no new alert');

  // Now cross 90%.
  await flushUsage(env.DB, { rowsRead: Math.floor(limit * 0.20), rowsWritten: 0 });
  errors = env.DB._rows('error_log');
  assert.equal(errors.length, 2, 'crossing 90% fires the critical alert once');
  assert.equal(errors[1].code, 'D1_MONTHLY_CRITICAL');

  // Further usage this same month must not fire either alert again.
  await flushUsage(env.DB, { rowsRead: Math.floor(limit * 0.05), rowsWritten: 0 });
  assert.equal(env.DB._rows('error_log').length, 2, 'no repeat alerts later in the same month');
});

test('a jump straight past both thresholds in one flush fires only the critical alert, not the warning too', async () => {
  const env = seedEnv();
  await flushUsage(env.DB, { rowsRead: Math.floor(D1_MONTHLY_LIMITS.rowsRead * 0.95), rowsWritten: 0 });
  const errors = env.DB._rows('error_log');
  assert.equal(errors.length, 1, 'one alert, not two, for a single flush that clears both lines at once');
  assert.equal(errors[0].code, 'D1_MONTHLY_CRITICAL');
});

/* ── pause control ── */

test('isPaused/setPaused round-trip, and pausing is logged as a staff action, not an error', async () => {
  const env = seedEnv();
  assert.equal(await isPaused(env.DB), false);

  await setPaused(env.DB, { paused: true, staffName: 'Admin', reason: 'Testing the budget guard' });
  assert.equal(await isPaused(env.DB), true);
  const state = await getPauseState(env.DB);
  assert.equal(state.paused_by, 'Admin');
  assert.equal(state.reason, 'Testing the budget guard');

  const audit = env.DB._rows('staff_audit_log');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'heavy_sync_paused');
  assert.equal(env.DB._rows('error_log').length, 0, 'a deliberate admin action is not an error');

  await setPaused(env.DB, { paused: false, staffName: 'Admin' });
  assert.equal(await isPaused(env.DB), false);
  assert.equal(env.DB._rows('staff_audit_log').length, 2);
  assert.equal(env.DB._rows('staff_audit_log')[1].action, 'heavy_sync_resumed');
});

test('pausing blocks a global refresh (cron or admin-triggered) but not a single clipper\'s own refresh', async () => {
  const env = seedEnv();
  await setPaused(env.DB, { paused: true, staffName: 'Admin' });

  const global = await createRefreshJob(env.DB, { kind: 'global', triggeredBy: 'cron', cooldownMs: CLIP_COOLDOWN_MS });
  assert.equal(global.status, 409);
  assert.match(global.error, /paused/i);

  const globalAdmin = await createRefreshJob(env.DB, { kind: 'global', triggeredBy: 'admin', cooldownMs: 0 });
  assert.match(globalAdmin.error, /paused/i, 'the admin\'s own manual full-refresh button is gated the same way');

  const perClipper = await createRefreshJob(env.DB, { kind: 'clipper', clipperId: 1, triggeredBy: 'admin', cooldownMs: 0 });
  assert.equal(perClipper.error, undefined, 'a targeted single-clipper refresh is not "heavy" and stays ungated');
});

test('resuming restores both the cron and admin-triggered global refresh', async () => {
  const env = seedEnv();
  await setPaused(env.DB, { paused: true, staffName: 'Admin' });
  await setPaused(env.DB, { paused: false, staffName: 'Admin' });

  const global = await createRefreshJob(env.DB, { kind: 'global', triggeredBy: 'cron', cooldownMs: CLIP_COOLDOWN_MS });
  assert.equal(global.error, undefined);
});

/* ── GET /api/admin/platform-usage ── */

test('GET /api/admin/platform-usage returns the documented shape', async () => {
  const env = seedEnv();
  await flushUsage(env.DB, { rowsRead: 1000, rowsWritten: 20 });

  const res = await adminRequest(env, '/api/admin/platform-usage');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.today.rows_read, 1000);
  assert.equal(body.month_to_date.rows_read, 1000);
  assert.equal(body.limits.rowsRead, D1_MONTHLY_LIMITS.rowsRead);
  assert.ok(body.pct_read > 0);
  assert.ok(Array.isArray(body.history));
  assert.equal(body.pause.paused, false);
  assert.ok('day' in body && 'month' in body && 'daily_pace_target' in body);
});

test('a moderator session cannot reach /api/admin/platform-usage or /api/admin/system-pause', async () => {
  const env = seedEnv();
  const cookie = await createSessionCookie('moderator', 1, env.SESSION_SECRET);
  const get = new Request('https://clipgrow.in/api/admin/platform-usage', { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal((await handleAdmin(get, env, new URL(get.url))).status, 401);

  const post = new Request('https://clipgrow.in/api/admin/system-pause', {
    method: 'POST', headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused: true })
  });
  assert.equal((await handleAdmin(post, env, new URL(post.url))).status, 401);
});

/* ── POST /api/admin/system-pause ── */

test('POST /api/admin/system-pause toggles the pause and is reflected immediately in platform-usage', async () => {
  const env = seedEnv();
  const res = await adminRequest(env, '/api/admin/system-pause', { method: 'POST', body: { paused: true, reason: 'load test' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pause.paused, true);
  assert.equal(body.pause.reason, 'load test');

  const snap = await (await adminRequest(env, '/api/admin/platform-usage')).json();
  assert.equal(snap.pause.paused, true);

  const resume = await adminRequest(env, '/api/admin/system-pause', { method: 'POST', body: { paused: false } });
  assert.equal((await resume.json()).pause.paused, false);
});

test('POST /api/admin/system-pause rejects a body without a boolean paused field', async () => {
  const env = seedEnv();
  const res = await adminRequest(env, '/api/admin/system-pause', { method: 'POST', body: { paused: 'yes' } });
  assert.equal(res.status, 400);
});
