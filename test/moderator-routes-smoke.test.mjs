// Route-dispatch smoke test for the moderator API (migration 023), mirroring
// test/admin-routes-smoke.test.mjs's own reasoning: proves a representative
// route from each stretch of handleModerator dispatches without the handler
// itself throwing, and that the moderator role boundary actually holds --
// nothing in this file can reach an admin-only action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleModerator } from '../src/routes/moderator.js';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';

const NOW = Date.now();
const SESSION_SECRET = 'test-secret';

async function moderatorRequest(env, path, { method = 'GET', body, moderatorId = 1 } = {}) {
  const cookie = await createSessionCookie('moderator', moderatorId, env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method,
    headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const url = new URL(request.url);
  return handleModerator(request, env, url);
}

function seedEnv() {
  const db = makeSqliteD1({
    moderators: [{ id: 1, username: 'jane', password_hash: 'h', password_salt: 's',
                   display_name: 'Jane', status: 'active', created_at: NOW }],
    clippers: [{ id: 1, username: 'clipper1', password_hash: 'h', password_salt: 's',
                 status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'Test Campaign', description: '', cpm: 40, budget: 10000,
                  status: 'active', created_at: NOW, model: 'cpm', min_views: 1000,
                  allowed_platforms: 'instagram' }]
  });
  return { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
}

const GET_ROUTES = [
  '/api/moderator/me',
  '/api/moderator/clippers',
  '/api/moderator/clippers/1',
  '/api/moderator/queue',
  '/api/moderator/reviewed'
];

for (const path of GET_ROUTES) {
  test(`GET ${path} dispatches without the handler throwing`, async () => {
    const env = seedEnv();
    const res = await moderatorRequest(env, path);
    assert.ok(res, `${path} returned no response`);
    assert.ok(res.status < 500, `${path} returned ${res.status}, expected < 500`);
  });
}

// Creating a clipper login used to be something a moderator could do too --
// removed on request so only the admin account can create logins. This route
// no longer exists in handleModerator at all, so it falls through to the
// same `return null` every unrecognised /api/moderator/* path hits (proving
// that, not just that it 404s some other way).
test('a moderator can no longer create a clipper -- the route does not exist', async () => {
  const env = seedEnv();
  const res = await moderatorRequest(env, '/api/moderator/clippers', {
    method: 'POST', body: { username: 'newclipper', password: 'longenough' }
  });
  assert.equal(res, null, 'POST /api/moderator/clippers is unhandled, not a working create endpoint');
  const row = await env.DB.prepare('SELECT id FROM clippers WHERE username = ?').bind('newclipper').first();
  assert.equal(row, null, 'no clipper was created');
});

test('a disabled moderator is fully cut off, not just read-only', async () => {
  const env = seedEnv();
  await env.DB.prepare("UPDATE moderators SET status = 'disabled' WHERE id = 1").run();
  const res = await moderatorRequest(env, '/api/moderator/me');
  assert.equal(res.status, 401);
});

test('a moderator session cannot reach any admin-only action', async () => {
  const env = seedEnv();
  const cookie = await createSessionCookie('moderator', 1, env.SESSION_SECRET);
  const request = new Request('https://clipgrow.in/api/admin/campaigns', {
    method: 'GET', headers: { Cookie: cookie.split(';')[0] }
  });
  const res = await handleAdmin(request, env, new URL(request.url));
  assert.equal(res.status, 401);
});

test('handleModerator does not claim admin or clipper paths', async () => {
  const env = seedEnv();
  const cookie = await createSessionCookie('moderator', 1, env.SESSION_SECRET);
  const request = new Request('https://clipgrow.in/api/admin/campaigns', {
    method: 'GET', headers: { Cookie: cookie.split(';')[0] }
  });
  const res = await handleModerator(request, env, new URL(request.url));
  assert.equal(res, null);
});
