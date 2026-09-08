// GET/PATCH /api/admin/error-log -- the admin-facing side of the error log.
// The one thing worth guarding directly at this layer (rather than assuming
// it falls out of error-log.js's own tests): contact info for the "message
// them" button is joined LIVE from clippers, not stored on the row, so an
// updated WhatsApp number is always the one actually used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';

const NOW = Date.now();
const SESSION_SECRET = 'test-secret';

function seedEnv() {
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'sayed', display_name: 'Sayed', contact_number: '9876543210',
                 discord_id: '305421934793015296', password_hash: 'h', password_salt: 's',
                 status: 'active', created_at: NOW }]
  });
  return { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
}

async function adminRequest(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('admin', 'admin', env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method, headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleAdmin(request, env, new URL(request.url));
}

test('GET joins a clipper error row with their current contact info', async () => {
  const env = seedEnv();
  await env.DB.prepare(
    `INSERT INTO error_log (actor_type, actor_id, actor_label, source, code, message, created_at)
     VALUES ('clipper', 1, 'Sayed', 'instagram_oauth', 'UNKNOWN', 'token exchange failed', ?)`
  ).bind(NOW).run();

  const { errors } = await adminRequest(env, '/api/admin/error-log').then(r => r.json());
  assert.equal(errors.length, 1);
  assert.equal(errors[0].contact_number, '9876543210');
  assert.equal(errors[0].discord_id, '305421934793015296');
});

test('GET never attaches contact info to a non-clipper row', async () => {
  const env = seedEnv();
  await env.DB.prepare(
    `INSERT INTO error_log (actor_type, actor_label, source, message, created_at)
     VALUES ('admin', 'Admin', 'api', 'something broke', ?)`
  ).bind(NOW).run();

  const { errors } = await adminRequest(env, '/api/admin/error-log').then(r => r.json());
  assert.equal(errors[0].contact_number, null);
  assert.equal(errors[0].discord_id, null);
});

test('GET ?unresolved=1 hides resolved rows', async () => {
  const env = seedEnv();
  await env.DB.prepare(
    `INSERT INTO error_log (actor_type, source, message, created_at, resolved_at) VALUES ('admin','api','old', ?, ?)`
  ).bind(NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO error_log (actor_type, source, message, created_at) VALUES ('admin','api','open', ?)`
  ).bind(NOW).run();

  const { errors } = await adminRequest(env, '/api/admin/error-log?unresolved=1').then(r => r.json());
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'open');
});

test('PATCH resolves an error', async () => {
  const env = seedEnv();
  await env.DB.prepare(
    `INSERT INTO error_log (actor_type, source, message, created_at) VALUES ('admin','api','x', ?)`
  ).bind(NOW).run();
  const [{ id }] = env.DB._rows('error_log');

  const res = await adminRequest(env, `/api/admin/error-log/${id}`, { method: 'PATCH', body: { resolved: true } });
  assert.equal(res.status, 200);
  assert.ok(env.DB._rows('error_log')[0].resolved_at);
});

test('PATCH on an already-resolved row 404s instead of silently no-op-ing', async () => {
  const env = seedEnv();
  await env.DB.prepare(
    `INSERT INTO error_log (actor_type, source, message, created_at, resolved_at) VALUES ('admin','api','x', ?, ?)`
  ).bind(NOW, NOW).run();
  const [{ id }] = env.DB._rows('error_log');

  const res = await adminRequest(env, `/api/admin/error-log/${id}`, { method: 'PATCH', body: { resolved: true } });
  assert.equal(res.status, 404);
});
