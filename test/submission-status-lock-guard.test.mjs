// PATCH/DELETE /api/admin/submissions/:id (pause/disqualify/delete a clip)
// had the same gap as the /unlock endpoint (see submission-unlock.test.mjs):
// both branches only checked `locked_at`/`payment_id` on the row as read a
// moment earlier, with no re-check on the actual write. A payout settling
// this exact clip in that gap would have gone through anyway -- silently
// changing a paid clip's status, or deleting its row outright. The two
// "must not be undone" tests below reproduce that gap directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';

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

function seedEnv(subOverrides = {}) {
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'clipper1', password_hash: 'h', password_salt: 's',
                 status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'Test Campaign', description: '', cpm: 40, budget: 10000,
                  status: 'active', created_at: NOW, model: 'cpm', min_views: 1000,
                  allowed_platforms: 'instagram' }],
    payments: [{ id: 999, clipper_id: 1, amount: 200, paid_at: NOW, created_at: NOW }],
    submissions: [{
      id: 1, clipper_id: 1, campaign_id: 1, platform: 'instagram', ig_media_id: 'm1',
      permalink: 'https://instagram.com/p/1', views: 400, earning: 100, status: 'active',
      created_at: NOW, ...subOverrides
    }]
  });
  return { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
}

// Hooks the route's own SELECT for this submission so a settlement can be
// simulated landing in the exact gap between that read and the route's
// subsequent write -- the same technique submission-unlock.test.mjs uses.
function injectConcurrentSettlement(env) {
  const originalPrepare = env.DB.prepare.bind(env.DB);
  let injected = false;
  env.DB.prepare = (sql) => {
    const stmt = originalPrepare(sql);
    if (sql === 'SELECT * FROM submissions WHERE id = ?' && !injected) {
      const origFirst = stmt.first.bind(stmt);
      stmt.first = async (...args) => {
        const row = await origFirst(...args);
        injected = true;
        env.DB._sqlite.prepare(
          "UPDATE submissions SET locked_at = ?, locked_earning = 200, lock_reason = 'paid', payment_id = 999 WHERE id = ?"
        ).run(Date.now(), row.id);
        return row;
      };
    }
    return stmt;
  };
}

test('PATCH: pausing an open clip succeeds', async () => {
  const env = seedEnv();
  const res = await adminRequest(env, '/api/admin/submissions/1', { method: 'PATCH', body: { status: 'paused' } });
  assert.equal(res.status, 200);
  assert.equal(env.DB._rows('submissions')[0].status, 'paused');
});

test('PATCH: refused on a clip already locked by a payment', async () => {
  const env = seedEnv({ locked_at: NOW, lock_reason: 'paid', payment_id: 999, locked_earning: 200 });
  const res = await adminRequest(env, '/api/admin/submissions/1', { method: 'PATCH', body: { status: 'paused' } });
  assert.equal(res.status, 409);
});

test('PATCH: refused on a clip closed at zero (no payment) too -- must reopen first', async () => {
  const env = seedEnv({ locked_at: NOW, lock_reason: 'below_min', locked_earning: 0 });
  const res = await adminRequest(env, '/api/admin/submissions/1', { method: 'PATCH', body: { status: 'paused' } });
  assert.equal(res.status, 409);
});

test('PATCH: a payment settling this exact clip between the read and the write must not be undone', async () => {
  const env = seedEnv();
  injectConcurrentSettlement(env);
  const res = await adminRequest(env, '/api/admin/submissions/1', { method: 'PATCH', body: { status: 'disqualified' } });
  assert.equal(res.status, 409, 'the write-time guard must catch what the read-time check could not have seen');

  const row = env.DB._rows('submissions')[0];
  assert.equal(row.status, 'active', "a paid clip's status must not change underneath the payment");
  assert.equal(row.lock_reason, 'paid');
  assert.equal(row.locked_earning, 200);
});

test('DELETE: a below-minimum lock with no payment can still be deleted outright', async () => {
  const env = seedEnv({ locked_at: NOW, lock_reason: 'below_min', locked_earning: 0 });
  const res = await adminRequest(env, '/api/admin/submissions/1', { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal(env.DB._rows('submissions').length, 0);
});

test('DELETE: refused outright on a clip already locked by a payment', async () => {
  const env = seedEnv({ locked_at: NOW, lock_reason: 'paid', payment_id: 999, locked_earning: 200 });
  const res = await adminRequest(env, '/api/admin/submissions/1', { method: 'DELETE' });
  assert.equal(res.status, 409);
  assert.equal(env.DB._rows('submissions').length, 1, 'a paid clip must never be deleted');
});

test('DELETE: a payment settling this exact clip between the read and the delete must not go through', async () => {
  const env = seedEnv();
  injectConcurrentSettlement(env);
  const res = await adminRequest(env, '/api/admin/submissions/1', { method: 'DELETE' });
  assert.equal(res.status, 409, 'the write-time guard must catch what the read-time check could not have seen');

  const row = env.DB._rows('submissions')[0];
  assert.ok(row, "the concurrently-paid clip's row must survive");
  assert.equal(row.lock_reason, 'paid');
  assert.equal(row.payment_id, 999);
});
