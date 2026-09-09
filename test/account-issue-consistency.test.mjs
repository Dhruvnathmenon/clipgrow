// GET /api/admin/clippers (the roster's "⚠ mismatch" / "N issue" badges) and
// GET /api/admin/accounts (the bucketed Issues panel) must always agree on
// what counts as an open issue -- both call db.js's accountIssues(). This
// reproduces the bug directly: unflagging a mismatch in the Issues panel
// used to leave the roster badge showing forever, because the roster had
// its own raw SQL check with no idea the acknowledgment columns existed.
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

function seedEnv() {
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'clipper1', password_hash: 'h', password_salt: 's',
                 status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'Test Campaign', description: '', cpm: 40, budget: 10000,
                  status: 'active', created_at: NOW, model: 'cpm', min_views: 1000,
                  allowed_platforms: 'instagram' }],
    social_accounts: [{ id: 1, clipper_id: 1, platform: 'instagram', external_id: 'ext1',
                        username: 'wrongaccount', status: 'connected', connected_at: NOW }],
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW,
                       account_id: 1 }],
    participation_accounts: [{ participation_id: 1, account_id: 1, platform: 'instagram', linked_at: NOW }],
    tester_requests: [{ id: 1, clipper_id: 1, campaign_id: 1, platform: 'instagram',
                        identifier: 'approvedaccount', ig_username: 'approvedaccount',
                        status: 'confirmed', requested_at: NOW }]
  });
  return { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
}

test('a mismatch counts as an issue in both the roster and the Issues panel', async () => {
  const env = seedEnv();
  const roster = await adminRequest(env, '/api/admin/clippers').then(r => r.json());
  assert.equal(roster.clippers[0].accounts_mismatched, 1);

  const buckets = await adminRequest(env, '/api/admin/accounts').then(r => r.json());
  assert.equal(buckets.issues.length, 1);
  assert.deepEqual(buckets.issues[0].reasons, ['mismatch']);
});

test('unflagging the mismatch clears it from BOTH the roster badge and the Issues panel', async () => {
  const env = seedEnv();
  const ack = await adminRequest(env, '/api/admin/accounts/1/acknowledge', {
    method: 'PATCH', body: { type: 'mismatch' }
  });
  assert.equal(ack.status, 200);

  const roster = await adminRequest(env, '/api/admin/clippers').then(r => r.json());
  assert.equal(roster.clippers[0].accounts_mismatched, 0, 'roster badge should have cleared');

  const buckets = await adminRequest(env, '/api/admin/accounts').then(r => r.json());
  assert.equal(buckets.issues.length, 0, 'Issues panel should be empty');
  assert.equal(buckets.active.length, 1, 'the account should have moved to Active');
});

test('a genuinely new mismatch re-flags in both places even after an old one was acknowledged', async () => {
  const env = seedEnv();
  await adminRequest(env, '/api/admin/accounts/1/acknowledge', { method: 'PATCH', body: { type: 'mismatch' } });
  // The clipper reconnects with yet another different account -- a real new
  // problem, not the one that was dismissed.
  await env.DB.prepare("UPDATE social_accounts SET username = 'yetanotheraccount' WHERE id = 1").run();

  const roster = await adminRequest(env, '/api/admin/clippers').then(r => r.json());
  assert.equal(roster.clippers[0].accounts_mismatched, 1);

  const buckets = await adminRequest(env, '/api/admin/accounts').then(r => r.json());
  assert.equal(buckets.issues.length, 1);
});

test('a revoked (removed) account is never counted as an open issue', async () => {
  const env = seedEnv();
  await env.DB.prepare("UPDATE social_accounts SET status = 'revoked', username = 'approvedaccount' WHERE id = 1").run();

  const roster = await adminRequest(env, '/api/admin/clippers').then(r => r.json());
  assert.equal(roster.clippers[0].accounts_unhealthy, 0);
  assert.equal(roster.clippers[0].accounts_mismatched, 0);

  // Removed accounts have no ongoing value, so they're excluded from the
  // query entirely unless specifically asked for.
  const buckets = await adminRequest(env, '/api/admin/accounts').then(r => r.json());
  assert.equal(buckets.issues.length, 0);
  assert.equal(buckets.removed.length, 0, 'not fetched by default -- nobody asked to see it');

  const withRemoved = await adminRequest(env, '/api/admin/accounts?removed=1').then(r => r.json());
  assert.equal(withRemoved.removed.length, 1, 'still reachable when explicitly requested');
});
