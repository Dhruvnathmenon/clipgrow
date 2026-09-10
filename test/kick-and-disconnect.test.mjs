// Two admin actions whose money/access semantics changed:
//
//  1. Kicking a clipper from a campaign now RELEASES their unpaid earnings
//     back into the pool (it used to freeze and keep paying them). Paid clips
//     are untouched.
//  2. Disconnect is one action with one meaning -- there is no longer a
//     separate "reset for new account". It never touches the clipper's access
//     approval, so they can reconnect and re-link on their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';

const NOW = Date.now();
const SECRET = 'test-secret';

async function adminReq(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('admin', 'admin', SECRET);
  const req = new Request(`https://clipgrow.in${path}`, {
    method, headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleAdmin(req, env, new URL(req.url));
}

test('kicking a clipper releases their unpaid earnings and logs the amount', async () => {
  const env = {
    DB: makeSqliteD1({
      clippers: [
        { id: 1, username: 'bad', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW },
        { id: 2, username: 'good', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }
      ],
      campaigns: [{ id: 1, name: 'C', description: '', cpm: 50, budget: 2000, status: 'active',
                    created_at: NOW, model: 'cpm', min_views: 100, allowed_platforms: 'instagram' }],
      participations: [
        { id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW },
        { id: 2, clipper_id: 2, campaign_id: 1, status: 'active', joined_at: NOW }
      ],
      submissions: [
        { id: 1, clipper_id: 1, campaign_id: 1, platform: 'instagram', ig_media_id: 'm1',
          permalink: 'p1', views: 40000, earning: 2000, clipper_earning: 2000, status: 'active',
          created_at: NOW - 2000, last_ok_sync_at: NOW },
        { id: 2, clipper_id: 2, campaign_id: 1, platform: 'instagram', ig_media_id: 'm2',
          permalink: 'p2', views: 40000, earning: 0, status: 'active',
          created_at: NOW - 1000, last_ok_sync_at: NOW }
      ]
    }),
    SESSION_SECRET: SECRET, ADMIN_PASSWORD: 'x'
  };

  const res = await adminReq(env, '/api/admin/participations/1', { method: 'PATCH', body: { status: 'kicked', note: 'botting' } });
  assert.equal(res.status, 200);

  const rows = env.DB._rows('submissions');
  assert.equal(rows.find(r => r.id === 1).earning, 0, 'kicked clipper is released');
  assert.equal(rows.find(r => r.id === 2).earning, 2000, 'the freed budget flowed to the active clipper');

  const log = env.DB._rows('staff_audit_log').find(l => l.action === 'clipper_kicked');
  assert.ok(log);
  assert.match(log.detail, /Released ₹2000/);
});

test('kicking never touches an already-paid clip', async () => {
  const env = {
    DB: makeSqliteD1({
      clippers: [{ id: 1, username: 'x', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }],
      campaigns: [{ id: 1, name: 'C', description: '', cpm: 50, budget: 5000, status: 'active',
                    created_at: NOW, model: 'cpm', min_views: 100, allowed_platforms: 'instagram' }],
      participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW }],
      payments: [{ id: 9, clipper_id: 1, amount: 1500, paid_at: NOW, created_at: NOW }],
      submissions: [
        { id: 1, clipper_id: 1, campaign_id: 1, platform: 'instagram', ig_media_id: 'm1', permalink: 'p1',
          views: 30000, earning: 1500, status: 'active', created_at: NOW - 3000,
          locked_at: NOW, locked_earning: 1500, lock_reason: 'paid', payment_id: 9 },
        { id: 2, clipper_id: 1, campaign_id: 1, platform: 'instagram', ig_media_id: 'm2', permalink: 'p2',
          views: 20000, earning: 1000, clipper_earning: 1000, status: 'active', created_at: NOW - 2000 }
      ]
    }),
    SESSION_SECRET: SECRET, ADMIN_PASSWORD: 'x'
  };

  await adminReq(env, '/api/admin/participations/1', { method: 'PATCH', body: { status: 'kicked', note: 'x' } });
  const rows = env.DB._rows('submissions');
  assert.equal(rows.find(r => r.id === 1).locked_earning, 1500, 'paid clip untouched');
  assert.equal(rows.find(r => r.id === 1).earning, 1500);
  assert.equal(rows.find(r => r.id === 2).earning, 0, 'unpaid clip released');
});

test('disconnect takes no body, frees the budget, and leaves the access request alone', async () => {
  const env = {
    DB: makeSqliteD1({
      clippers: [{ id: 1, username: 'x', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }],
      campaigns: [{ id: 1, name: 'C', description: '', cpm: 50, budget: 5000, status: 'active',
                    created_at: NOW, model: 'cpm', min_views: 100, allowed_platforms: 'instagram' }],
      social_accounts: [{ id: 1, clipper_id: 1, platform: 'instagram', username: 'ig1', external_id: 'ext1',
                          status: 'connected', access_token: 't', auto_import: 1, connected_at: NOW }],
      participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', account_id: 1, joined_at: NOW }],
      participation_accounts: [{ participation_id: 1, account_id: 1, platform: 'instagram', linked_at: NOW }],
      tester_requests: [{ id: 1, clipper_id: 1, ig_username: 'ig1', identifier: 'ig1', platform: 'instagram',
                          status: 'approved', campaign_id: 1, requested_at: NOW }],
      submissions: [{ id: 1, clipper_id: 1, campaign_id: 1, account_id: 1, platform: 'instagram', ig_media_id: 'm1',
                      permalink: 'p1', views: 20000, earning: 1000, status: 'active', created_at: NOW - 1000 }]
    }),
    SESSION_SECRET: SECRET, ADMIN_PASSWORD: 'x'
  };

  const res = await adminReq(env, '/api/admin/accounts/1', { method: 'DELETE' });
  assert.equal(res.status, 200);

  assert.equal(env.DB._rows('submissions').length, 0, 'the unpaid clip is gone, its budget released');
  assert.equal(env.DB._rows('participation_accounts').length, 0, 'unlinked from the participation');
  assert.equal(env.DB._rows('tester_requests')[0].status, 'approved', 'access approval is left intact for a clean reconnect');
});
