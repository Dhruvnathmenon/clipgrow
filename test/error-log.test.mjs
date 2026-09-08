// The error log (src/error-log.js, migration 038) exists because an
// Instagram/YouTube connect failure used to be a one-time toast on the
// dashboard and nothing more -- no record survived the page load, so the
// founder had no way to see what clippers were actually running into. These
// tests cover the module directly, then the two real call sites that feed
// it: instagram-auth.js and youtube-auth.js's own `failure()` helpers,
// including the two outcomes that must stay SILENT (NOT_APPROVED, DENIED --
// normal flow, not a problem).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { logError, listErrors, resolveError, pruneErrorLog, ERROR_LOG_RETENTION_MS } from '../src/error-log.js';
import { handleInstagramAuth } from '../src/routes/instagram-auth.js';
import { handleYoutubeAuth } from '../src/routes/youtube-auth.js';
import { createSessionCookie } from '../src/auth.js';

const NOW = Date.now();
const SESSION_SECRET = 'test-secret';

/* ── the module itself ── */

function bareDb() {
  return makeSqliteD1({});
}

test('logError writes a row; listErrors returns it newest-first', async () => {
  const db = bareDb();
  await logError(db, { actorType: 'clipper', actorId: 1, actorLabel: 'sayed', source: 'instagram_oauth', code: 'X', message: 'first' });
  await logError(db, { actorType: 'admin', source: 'api', message: 'second' });
  const rows = await listErrors(db);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].message, 'second', 'newest first');
  assert.equal(rows[1].actor_label, 'sayed');
});

test('listErrors with unresolvedOnly hides resolved rows', async () => {
  const db = bareDb();
  await logError(db, { actorType: 'admin', source: 'api', message: 'one' });
  await logError(db, { actorType: 'admin', source: 'api', message: 'two' });
  const [{ id }] = await listErrors(db);
  await resolveError(db, id);
  const open = await listErrors(db, { unresolvedOnly: true });
  assert.equal(open.length, 1);
  assert.equal(open[0].message, 'one');
});

test('resolveError is idempotent and reversible', async () => {
  const db = bareDb();
  await logError(db, { actorType: 'admin', source: 'api', message: 'x' });
  const [{ id }] = await listErrors(db);
  assert.equal(await resolveError(db, id), true);
  assert.equal(await resolveError(db, id), false, 'already resolved -- no-op, not an error');
  assert.equal(await resolveError(db, id, { resolved: false }), true, 'un-resolve works too');
  const row = (await listErrors(db))[0];
  assert.equal(row.resolved_at, null);
});

test('pruneErrorLog deletes only rows past the 7-day retention window', async () => {
  const db = bareDb();
  const old = NOW - ERROR_LOG_RETENTION_MS - 1000;
  const recent = NOW - 1000;
  await db.prepare(
    `INSERT INTO error_log (actor_type, source, message, created_at) VALUES ('admin','api','old', ?)`
  ).bind(old).run();
  await db.prepare(
    `INSERT INTO error_log (actor_type, source, message, created_at) VALUES ('admin','api','recent', ?)`
  ).bind(recent).run();
  const deleted = await pruneErrorLog(db, { now: NOW });
  assert.equal(deleted, 1);
  const remaining = await listErrors(db);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].message, 'recent');
});

test('logError never throws even if the write itself fails', async () => {
  const db = { prepare() { throw new Error('DB unavailable'); } };
  await assert.doesNotReject(() => logError(db, { actorType: 'admin', source: 'api', message: 'x' }));
});

/* ── instagram-auth.js's real failure() call sites ── */

function seedAuthEnv({ igConfigured = true, approved = false } = {}) {
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'clipper1', display_name: 'Clipper One', password_hash: 'h', password_salt: 's',
                 status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'IG Campaign', description: '', cpm: 40, budget: 10000,
                  status: 'active', created_at: NOW, model: 'cpm', min_views: 1000,
                  allowed_platforms: 'instagram' }],
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW }],
    tester_requests: approved
      ? [{ id: 1, clipper_id: 1, campaign_id: 1, platform: 'instagram', ig_username: '@h', identifier: '@h',
           status: 'confirmed', requested_at: NOW, auto_import: 1 }]
      : []
  });
  const env = { DB: db, SESSION_SECRET };
  if (igConfigured) { env.IG_CLIENT_ID = 'x'; env.IG_CLIENT_SECRET = 'y'; }
  return env;
}

async function clipperGet(handler, env, path) {
  const cookie = await createSessionCookie('clipper', 1, env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, { headers: { Cookie: cookie.split(';')[0] } });
  return handler(request, env, new URL(request.url));
}

test('instagram: NOT_CONFIGURED is a real problem and gets logged, with the clipper identified', async () => {
  const env = seedAuthEnv({ igConfigured: false });
  const res = await clipperGet(handleInstagramAuth, env, '/api/auth/instagram/start?campaign_id=1');
  assert.equal(res.status, 302);
  const rows = await listErrors(env.DB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_type, 'clipper');
  assert.equal(rows[0].actor_id, 1);
  assert.equal(rows[0].actor_label, 'Clipper One');
  assert.equal(rows[0].source, 'instagram_oauth');
  assert.equal(rows[0].code, 'NOT_CONFIGURED');
});

test('instagram: NOT_APPROVED is normal flow and must stay silent', async () => {
  const env = seedAuthEnv({ approved: false });
  const res = await clipperGet(handleInstagramAuth, env, '/api/auth/instagram/start?campaign_id=1');
  assert.equal(res.status, 302);
  const rows = await listErrors(env.DB);
  assert.equal(rows.length, 0, 'not-yet-approved is expected, not an error worth logging');
});

test('instagram: an approved request reaching the real connect step logs nothing (the happy path)', async () => {
  const env = seedAuthEnv({ approved: true });
  const res = await clipperGet(handleInstagramAuth, env, '/api/auth/instagram/start?campaign_id=1');
  assert.equal(res.status, 302); // redirects to Instagram's own authorize URL
  const rows = await listErrors(env.DB);
  assert.equal(rows.length, 0);
});

/* ── youtube-auth.js's real failure() call sites -- same shape, own file ── */

function seedYtEnv({ ytConfigured = true } = {}) {
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'clipper1', display_name: 'Clipper One', password_hash: 'h', password_salt: 's',
                 status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'YT Campaign', description: '', cpm: 40, budget: 10000,
                  status: 'active', created_at: NOW, model: 'cpm', min_views: 1000,
                  allowed_platforms: 'youtube' }],
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW }]
  });
  const env = { DB: db, SESSION_SECRET };
  if (ytConfigured) { env.YT_CLIENT_ID = 'x'; env.YT_CLIENT_SECRET = 'y'; }
  return env;
}

test('youtube: NOT_CONFIGURED gets logged the same way instagram does', async () => {
  const env = seedYtEnv({ ytConfigured: false });
  const res = await clipperGet(handleYoutubeAuth, env, '/api/auth/youtube/start?campaign_id=1');
  assert.equal(res.status, 302);
  const rows = await listErrors(env.DB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'youtube_oauth');
  assert.equal(rows[0].code, 'NOT_CONFIGURED');
  assert.equal(rows[0].actor_label, 'Clipper One');
});

test('youtube: NOT_APPROVED stays silent too', async () => {
  const env = seedYtEnv();
  const res = await clipperGet(handleYoutubeAuth, env, '/api/auth/youtube/start?campaign_id=1');
  assert.equal(res.status, 302);
  const rows = await listErrors(env.DB);
  assert.equal(rows.length, 0);
});
