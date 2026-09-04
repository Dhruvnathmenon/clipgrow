// Route-dispatch smoke test for the admin API.
//
// Every other test in this project checks a query or a function in
// isolation -- nothing actually calls handleAdmin the way a real request
// does. That gap let a real incident through: the finance-routes patch
// reassigned the shared `params` variable (`params = matchPath(...)`) before
// its own `let params = ...` declaration further down the same function.
// Because `let` is scoped to the whole function from the top, that made
// EVERY admin GET route past the finance block throw
// "ReferenceError: Cannot access 'params' before initialization" --
// campaigns, clippers, payments, everything except the handful of exact-path
// routes (login, overview, the finance ones) declared before the bug. Only
// Overview stayed up, which is exactly why the break looked campaigns-
// specific from the admin panel.
//
// This test does not re-verify business logic (that's what finance.test.mjs,
// payouts.test.mjs etc. are for) -- it just proves that a representative GET
// route from each stretch of the file dispatches without the handler itself
// throwing a JS error. A `let`/TDZ mistake, a typo'd variable, or a dangling
// reference anywhere in that dispatch chain fails this immediately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';

const NOW = Date.now();
const SESSION_SECRET = 'test-secret';

async function adminRequest(env, path, { method = 'GET' } = {}) {
  const cookie = await createSessionCookie('admin', 'admin', env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method,
    headers: { Cookie: cookie.split(';')[0] }
  });
  const url = new URL(request.url);
  // Mirrors worker.js's own dispatch: a thrown error here is the bug this
  // test exists to catch, so it is deliberately NOT try/caught.
  return handleAdmin(request, env, url);
}

function seedEnv() {
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'clipper1', password_hash: 'h', password_salt: 's',
                 status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'Test Campaign', description: '', cpm: 40, budget: 10000,
                  status: 'active', created_at: NOW, model: 'cpm', min_views: 1000,
                  allowed_platforms: 'instagram' }],
    clients: [{ id: 1, username: 'client1', password_hash: 'h', password_salt: 's',
                company_name: 'Client Co', status: 'active', created_at: NOW }]
  });
  return { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
}

// One representative GET route from every stretch of the file: before the
// finance block, inside it, and after it (where the incident actually
// surfaced). A 404 for a route this seed doesn't have data for is fine --
// the only failure mode this test cares about is the handler throwing.
const GET_ROUTES = [
  '/api/admin/overview',
  '/api/admin/finance/campaigns',
  '/api/admin/finance/campaigns/1',
  '/api/admin/campaigns',
  '/api/admin/campaigns/1',
  '/api/admin/campaigns/1/participants',
  '/api/admin/clippers',
  '/api/admin/clippers/1',
  '/api/admin/clippers/1/payable',
  '/api/admin/payments',
  '/api/admin/clients'
];

for (const path of GET_ROUTES) {
  test(`GET ${path} dispatches without the handler throwing`, async () => {
    const env = seedEnv();
    const res = await adminRequest(env, path);
    assert.ok(res, `${path} returned no response`);
    // A well-formed 4xx/2xx is fine -- only an uncaught throw (which node:test
    // surfaces as a failed test) represents the bug class this guards against.
    assert.ok(res.status < 500, `${path} returned ${res.status}, expected < 500`);
  });
}

test('hitting a finance route then a post-finance route in one session does not corrupt shared state', async () => {
  const env = seedEnv();
  // This ordering is exactly what broke in production: a finance/:id route
  // (which assigns to `params` before the file's own `let params`) followed
  // by a plain campaigns route (which appears after the `let`).
  const first = await adminRequest(env, '/api/admin/finance/campaigns/1');
  const second = await adminRequest(env, '/api/admin/campaigns');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const body = await second.json();
  assert.equal(body.campaigns.length, 1);
});
