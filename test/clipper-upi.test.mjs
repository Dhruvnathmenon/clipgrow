// A clipper's UPI ID + account name, so the admin can pay them directly
// without contacting them on every payout run.
//
// The one requirement worth a dedicated test beyond "does it save": this
// must be admin+clipper only. It is deliberately never added to
// publicClipper() (shared by admin.js and moderator.js), so the boundary
// test here is what actually proves a moderator session can never see it --
// not just a comment claiming so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleClipper } from '../src/routes/clipper.js';
import { handleAdmin } from '../src/routes/admin.js';
import { handleModerator } from '../src/routes/moderator.js';
import { createSessionCookie } from '../src/auth.js';
import { normaliseUpiId, validateUpiId } from '../src/db.js';

const NOW = Date.now();
const SESSION_SECRET = 'test-secret';

function seedEnv() {
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'clipper1', password_hash: 'h', password_salt: 's',
                 status: 'active', created_at: NOW }],
    moderators: [{ id: 1, username: 'jane', password_hash: 'h', password_salt: 's',
                   display_name: 'Jane', status: 'active', created_at: NOW }]
  });
  return { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
}

async function clipperRequest(env, path, { method = 'GET', body, clipperId = 1 } = {}) {
  const cookie = await createSessionCookie('clipper', clipperId, env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method,
    headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleClipper(request, env, new URL(request.url));
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

async function moderatorRequest(env, path) {
  const cookie = await createSessionCookie('moderator', 1, env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method: 'GET', headers: { Cookie: cookie.split(';')[0] }
  });
  return handleModerator(request, env, new URL(request.url));
}

/* ── validateUpiId / normaliseUpiId ── */

test('validateUpiId accepts real-shaped UPI ids and rejects obvious junk', () => {
  assert.equal(validateUpiId('9999999999@upi'), null);
  assert.equal(validateUpiId('  ravi.k@oksbi  '), null);
  assert.equal(validateUpiId(''), 'Enter a UPI ID');
  assert.ok(validateUpiId('not-a-upi-id'), 'no @ at all');
  assert.ok(validateUpiId('a@b@c'), 'more than one @');
});

test('normaliseUpiId trims and strips internal whitespace', () => {
  assert.equal(normaliseUpiId('  9999999999@upi '), '9999999999@upi');
});

/* ── clipper self-service ── */

test('a clipper with no UPI on file sees null, not a missing field', async () => {
  const env = seedEnv();
  const res = await clipperRequest(env, '/api/clipper/me');
  assert.equal(res.status, 200);
  const { clipper } = await res.json();
  assert.equal(clipper.upi_id, null);
  assert.equal(clipper.upi_account_name, null);
});

test('a clipper can set their own UPI details', async () => {
  const env = seedEnv();
  const res = await clipperRequest(env, '/api/clipper/me/upi', {
    method: 'PATCH', body: { upiId: '9999999999@upi', accountName: 'Ravi Kumar' }
  });
  assert.equal(res.status, 200);

  const row = await env.DB.prepare('SELECT upi_id, upi_account_name FROM clippers WHERE id = 1').first();
  assert.equal(row.upi_id, '9999999999@upi');
  assert.equal(row.upi_account_name, 'Ravi Kumar');

  const me = await (await clipperRequest(env, '/api/clipper/me')).json();
  assert.equal(me.clipper.upi_id, '9999999999@upi');
  assert.equal(me.clipper.upi_account_name, 'Ravi Kumar');
});

test('an invalid UPI id is rejected before it reaches the database', async () => {
  const env = seedEnv();
  const res = await clipperRequest(env, '/api/clipper/me/upi', {
    method: 'PATCH', body: { upiId: 'nope', accountName: 'Ravi Kumar' }
  });
  assert.equal(res.status, 400);
  const row = await env.DB.prepare('SELECT upi_id FROM clippers WHERE id = 1').first();
  assert.equal(row.upi_id, null);
});

test('a blank account name is rejected even with a valid UPI id', async () => {
  const env = seedEnv();
  const res = await clipperRequest(env, '/api/clipper/me/upi', {
    method: 'PATCH', body: { upiId: '9999999999@upi', accountName: '  ' }
  });
  assert.equal(res.status, 400);
});

test('a disabled clipper can still update their UPI details', async () => {
  // Same reasoning as password change: a disabled account can be owed money
  // from before it was disabled and must still be able to say how to pay it.
  const env = seedEnv();
  await env.DB.prepare("UPDATE clippers SET status = 'disabled' WHERE id = 1").run();
  const res = await clipperRequest(env, '/api/clipper/me/upi', {
    method: 'PATCH', body: { upiId: '9999999999@upi', accountName: 'Ravi Kumar' }
  });
  assert.equal(res.status, 200);
});

/* ── admin visibility + edit ── */

test('the admin roster includes UPI details', async () => {
  const env = seedEnv();
  await env.DB.prepare("UPDATE clippers SET upi_id = '9999999999@upi', upi_account_name = 'Ravi Kumar' WHERE id = 1").run();
  const { clippers } = await (await adminRequest(env, '/api/admin/clippers')).json();
  assert.equal(clippers[0].upi_id, '9999999999@upi');
  assert.equal(clippers[0].upi_account_name, 'Ravi Kumar');
});

test('the admin clipper detail includes UPI details', async () => {
  const env = seedEnv();
  await env.DB.prepare("UPDATE clippers SET upi_id = '9999999999@upi', upi_account_name = 'Ravi Kumar' WHERE id = 1").run();
  const { clipper } = await (await adminRequest(env, '/api/admin/clippers/1')).json();
  assert.equal(clipper.upi_id, '9999999999@upi');
  assert.equal(clipper.upi_account_name, 'Ravi Kumar');
});

test('the admin can fix a UPI typo through the same Edit action as username/password', async () => {
  const env = seedEnv();
  const res = await adminRequest(env, '/api/admin/clippers/1', {
    method: 'PATCH', body: { upi_id: '8888888888@oksbi', upi_account_name: 'Ravi K' }
  });
  assert.equal(res.status, 200);
  const row = await env.DB.prepare('SELECT upi_id, upi_account_name FROM clippers WHERE id = 1').first();
  assert.equal(row.upi_id, '8888888888@oksbi');
  assert.equal(row.upi_account_name, 'Ravi K');
});

test('the admin edit rejects an invalid UPI id the same way the clipper endpoint does', async () => {
  const env = seedEnv();
  const res = await adminRequest(env, '/api/admin/clippers/1', {
    method: 'PATCH', body: { upi_id: 'garbage' }
  });
  assert.equal(res.status, 400);
});

/* ── the actual privacy boundary ── */

test('a moderator can never see a clipper UPI id or account name, in the roster or the detail view', async () => {
  const env = seedEnv();
  await env.DB.prepare("UPDATE clippers SET upi_id = '9999999999@upi', upi_account_name = 'Ravi Kumar' WHERE id = 1").run();

  const roster = await (await moderatorRequest(env, '/api/moderator/clippers')).json();
  assert.equal(roster.clippers[0].upi_id, undefined);
  assert.equal(roster.clippers[0].upi_account_name, undefined);

  const detail = await (await moderatorRequest(env, '/api/moderator/clippers/1')).json();
  assert.equal(detail.clipper.upi_id, undefined);
  assert.equal(detail.clipper.upi_account_name, undefined);
});
