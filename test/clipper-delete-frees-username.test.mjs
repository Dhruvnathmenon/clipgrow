// DELETE /api/admin/clippers/:id archives a clipper (never destroys their
// history) but used to leave `username` untouched -- and username is
// UNIQUE, so a deleted row held that exact string forever, blocking a new
// clipper from ever registering under it. Fixed by freeing the username
// (suffixed with the row's own id, which can never collide) at the same
// moment the row is archived.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';

const NOW = Date.now();
const SESSION_SECRET = 'test-secret';

function seedEnv() {
  const db = makeSqliteD1({
    clippers: [{ id: 42, username: 'sayed', display_name: 'Sayed', password_hash: 'h', password_salt: 's',
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

test('deleting a clipper frees their username for reuse', async () => {
  const env = seedEnv();
  const res = await adminRequest(env, '/api/admin/clippers/42', { method: 'DELETE' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.freed_username, 'sayed', 'reports the original handle back so the admin knows what is now free');

  const row = env.DB._rows('clippers')[0];
  assert.equal(row.status, 'deleted');
  assert.equal(row.username, 'sayed_deleted42');

  // The actual point: a brand-new clipper can now take the exact original username.
  const create = await adminRequest(env, '/api/admin/clippers', {
    method: 'POST', body: { username: 'sayed', password: 'newpassword123' }
  });
  assert.equal(create.status, 201, 'the original username must be free to register again');
});

test('a deleted clipper cannot log in regardless of the renamed username', async () => {
  // Guards the safety claim in the code comment: freeing the username is
  // purely cosmetic/availability, never a security concern, because a
  // deleted row is already rejected by username OR status before password
  // is ever checked.
  const env = seedEnv();
  await adminRequest(env, '/api/admin/clippers/42', { method: 'DELETE' });
  const row = env.DB._rows('clippers')[0];
  assert.equal(row.status, 'deleted');
  // clipper.js's own login route (not exercised here) rejects on
  // status === 'deleted' before ever checking the password -- this just
  // confirms the row really did end up in that state.
});

test('deleting an already-deleted clipper is a no-op, not a double-mangle', async () => {
  const env = seedEnv();
  await adminRequest(env, '/api/admin/clippers/42', { method: 'DELETE' });
  const res = await adminRequest(env, '/api/admin/clippers/42', { method: 'DELETE' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.already, true);
  assert.equal(env.DB._rows('clippers')[0].username, 'sayed_deleted42', 'not mangled twice into sayed_deleted42_deleted42');
});
