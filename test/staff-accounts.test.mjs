// The "gold standard" rule: display_name is never free text at creation --
// it's always the (lowercase) username with its first letter capitalised --
// and a username is always forced lowercase, at creation AND when an admin
// edits one later. Covers both clippers and moderators, since both went
// through the same change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';
import { defaultDisplayName } from '../src/db.js';

const NOW = Date.now();
const SESSION_SECRET = 'test-secret';

async function adminRequest(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('admin', 'admin', env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method,
    headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleAdmin(request, env, new URL(request.url));
}

function seedEnv() {
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'existing', password_hash: 'h', password_salt: 's',
                 display_name: 'Existing', status: 'active', created_at: NOW }],
    moderators: [{ id: 1, username: 'jane', password_hash: 'h', password_salt: 's',
                   display_name: 'Jane', status: 'active', created_at: NOW }]
  });
  return { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
}

test('defaultDisplayName capitalises the first letter of an already-lowercase username', () => {
  assert.equal(defaultDisplayName('ravi'), 'Ravi');
  assert.equal(defaultDisplayName('  Ravi Edits  '), 'Raviedits');
  assert.equal(defaultDisplayName(''), '');
});

test('creating a clipper ignores any display_name sent and uses the capitalised username', async () => {
  const env = seedEnv();
  const res = await adminRequest(env, '/api/admin/clippers', {
    method: 'POST', body: { username: 'newclip', password: 'longenough', display_name: 'Should Be Ignored' }
  });
  assert.equal(res.status, 201);
  const row = await env.DB.prepare('SELECT display_name FROM clippers WHERE username = ?').bind('newclip').first();
  assert.equal(row.display_name, 'Newclip');
});

test('creating a moderator ignores any display_name sent and uses the capitalised username', async () => {
  const env = seedEnv();
  const res = await adminRequest(env, '/api/admin/moderators', {
    method: 'POST', body: { username: 'bob', password: 'longenough', display_name: 'Should Be Ignored' }
  });
  assert.equal(res.status, 201);
  const row = await env.DB.prepare('SELECT display_name FROM moderators WHERE username = ?').bind('bob').first();
  assert.equal(row.display_name, 'Bob');
});

test('editing a clipper username lowercases it and rejects a clash with another clipper', async () => {
  const env = seedEnv();
  await env.DB.prepare(
    "INSERT INTO clippers (id, username, password_hash, password_salt, status, created_at) VALUES (2, 'other', 'h', 's', 'active', ?)"
  ).bind(NOW).run();

  const clash = await adminRequest(env, '/api/admin/clippers/2', { method: 'PATCH', body: { username: 'EXISTING' } });
  assert.equal(clash.status, 409);

  const ok = await adminRequest(env, '/api/admin/clippers/2', { method: 'PATCH', body: { username: '  Renamed  ' } });
  assert.equal(ok.status, 200);
  const row = await env.DB.prepare('SELECT username FROM clippers WHERE id = 2').first();
  assert.equal(row.username, 'renamed');
});

test('editing a moderator username lowercases it and rejects a clash with another moderator', async () => {
  const env = seedEnv();
  await env.DB.prepare(
    "INSERT INTO moderators (id, username, password_hash, password_salt, status, created_at) VALUES (2, 'other', 'h', 's', 'active', ?)"
  ).bind(NOW).run();

  const clash = await adminRequest(env, '/api/admin/moderators/2', { method: 'PATCH', body: { username: 'JANE' } });
  assert.equal(clash.status, 409);

  const ok = await adminRequest(env, '/api/admin/moderators/2', { method: 'PATCH', body: { username: 'Bob' } });
  assert.equal(ok.status, 200);
  const row = await env.DB.prepare('SELECT username FROM moderators WHERE id = 2').first();
  assert.equal(row.username, 'bob');
});

test('editing a login can still change display name and password together', async () => {
  const env = seedEnv();
  const res = await adminRequest(env, '/api/admin/clippers/1', {
    method: 'PATCH', body: { display_name: 'Custom Name', password: 'brandnewpass' }
  });
  assert.equal(res.status, 200);
  const row = await env.DB.prepare('SELECT display_name, password_hash FROM clippers WHERE id = 1').first();
  assert.equal(row.display_name, 'Custom Name');
  assert.notEqual(row.password_hash, 'h');
});
