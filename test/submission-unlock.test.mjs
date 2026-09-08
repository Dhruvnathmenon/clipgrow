// POST /api/admin/submissions/:id/unlock reopens a clip that was closed at
// zero for missing the campaign minimum. Before this test existed, the
// endpoint had zero coverage -- including of the exact race it now guards
// against: its two safety checks (`locked_at` set, `lock_reason !== 'paid'`)
// were only ever verified against the row as read a moment earlier, and the
// actual UPDATE that nulled `locked_at`/`locked_earning`/`lock_reason` carried
// no re-check at write time. A payout settling (and thus paying) this exact
// clip in the gap between that read and that write would have silently
// erased a real payment's lock -- the one thing CLAUDE.md's "one rule"
// exists to prevent. The last test below reproduces that gap directly rather
// than just asserting the SQL text looks right.
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
    // payment_id is a real FK -- any submission carrying one needs a row here.
    payments: [
      { id: 5, clipper_id: 1, amount: 200, paid_at: NOW, created_at: NOW },
      { id: 999, clipper_id: 1, amount: 200, paid_at: NOW, created_at: NOW }
    ],
    submissions: [{
      id: 1, clipper_id: 1, campaign_id: 1, platform: 'instagram', ig_media_id: 'm1',
      permalink: 'https://instagram.com/p/1', views: 400, earning: 0, status: 'active',
      created_at: NOW, locked_at: NOW - 1000, locked_earning: 0, lock_reason: 'below_min',
      ...subOverrides
    }]
  });
  return { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
}

test('reopens a closed-at-zero clip, reallocates the campaign, and logs it', async () => {
  const env = seedEnv();
  const res = await adminRequest(env, '/api/admin/submissions/1/unlock', { method: 'POST' });
  assert.equal(res.status, 200);

  const row = env.DB._rows('submissions')[0];
  assert.equal(row.locked_at, null);
  assert.equal(row.locked_earning, null);
  assert.equal(row.lock_reason, null);

  const [entry] = env.DB._rows('staff_audit_log');
  assert.ok(entry, 'reopening a clip should leave an audit trail');
  assert.equal(entry.action, 'submission_unlocked');
  assert.equal(entry.target_type, 'submission');
  assert.equal(entry.target_id, 1);
});

test('a clip that is not locked at all is refused', async () => {
  const env = seedEnv({ locked_at: null, locked_earning: null, lock_reason: null });
  const res = await adminRequest(env, '/api/admin/submissions/1/unlock', { method: 'POST' });
  assert.equal(res.status, 400);
});

test('a clip locked by a real payment is refused -- must go through payment reversal', async () => {
  const env = seedEnv({ lock_reason: 'paid', locked_earning: 200, payment_id: 5 });
  const res = await adminRequest(env, '/api/admin/submissions/1/unlock', { method: 'POST' });
  assert.equal(res.status, 409);

  // Refused at the read-time check -- confirms it never even reaches the
  // write, so the payment's lock is definitely untouched.
  const row = env.DB._rows('submissions')[0];
  assert.equal(row.lock_reason, 'paid');
  assert.equal(row.locked_earning, 200);
});

test('unknown submission 404s', async () => {
  const env = seedEnv();
  const res = await adminRequest(env, '/api/admin/submissions/999/unlock', { method: 'POST' });
  assert.equal(res.status, 404);
});

test('a payout settling this exact clip between the read and the write must not be undone', async () => {
  const env = seedEnv(); // starts as a normal below_min lock, passes both read-time checks
  const originalPrepare = env.DB.prepare.bind(env.DB);
  let injected = false;
  // Stand in for the real race: a settlement job runs and pays this clip in
  // the moment between the route's own SELECT and its UPDATE. Hooked onto
  // the exact SELECT the route issues, fired the instant it resolves -- by
  // the time the route's UPDATE runs, the row it read is already stale.
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

  const res = await adminRequest(env, '/api/admin/submissions/1/unlock', { method: 'POST' });
  assert.equal(res.status, 409, 'the write-time guard must catch what the read-time check could not have seen');

  const row = env.DB._rows('submissions')[0];
  assert.equal(row.lock_reason, 'paid', "the concurrently-landed payment's lock must survive");
  assert.equal(row.locked_earning, 200);
  assert.equal(row.payment_id, 999);

  const auditRows = env.DB._rows('staff_audit_log');
  assert.equal(auditRows.length, 0, 'a rejected reopen must not log a submission_unlocked entry');
});
