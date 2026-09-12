// A client asked to see how much they've paid and how much is left to pay
// on their own campaign dashboard -- kept deliberately simple by request:
// paid = the full amount actually sent; left = budget - paid, floored at 0.
// See clientBilling() in src/routes/client.js for the reasoning, including
// why "paid" can't be read straight off the client_payment ledger category
// alone (it would understate what was actually sent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleClient } from '../src/routes/client.js';
import { recordClientPayment } from '../src/finance.js';
import { createSessionCookie } from '../src/auth.js';

const NOW = Date.now();
const SECRET = 'test-secret';

async function clientReq(env, path, clientId = 1) {
  const cookie = await createSessionCookie('client', clientId, SECRET);
  const req = new Request(`https://clipgrow.in${path}`, { headers: { Cookie: cookie.split(';')[0] } });
  return handleClient(req, env, new URL(req.url));
}

function seed({ kind = 'client', feePercent = 20, budget = 100000 } = {}) {
  return makeSqliteD1({
    clients: [{ id: 1, username: 'brand', password_hash: 'h', password_salt: 's', status: 'active',
                company_name: 'Brand Co', created_at: NOW }],
    clippers: [{ id: 1, username: 'c1', password_hash: 'h', password_salt: 's', status: 'active',
                 display_name: 'Clipper One', created_at: NOW }],
    campaigns: [{ id: 1, name: 'Acme', description: '', cpm: 50, budget, status: 'active',
                  created_at: NOW, model: 'cpm', min_views: 100, allowed_platforms: 'instagram',
                  campaign_kind: kind, fee_percent: feePercent }],
    client_campaigns: [{ client_id: 1, campaign_id: 1, granted_at: NOW }],
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW }],
    submissions: [{
      id: 10, clipper_id: 1, campaign_id: 1, platform: 'instagram', ig_media_id: 'm10',
      permalink: 'https://instagram.com/p/10', views: 20000, earning: 1000, status: 'active',
      created_at: NOW - 1000, last_ok_sync_at: NOW - 500
    }]
  });
}

test('paid is the full amount actually sent (fee included), not just the clipper-share half of the ledger', async () => {
  const db = seed();
  // Client sends 1200 total: 1000 clipper pool + 200 (20%) fee.
  await recordClientPayment(db, { clientId: 1, campaignId: 1, amount: 1200, feePercent: 20 });

  const { billing } = await clientReq({ DB: db, SESSION_SECRET: SECRET }, '/api/client/campaigns/1').then(r => r.json());
  assert.equal(billing.paid, 1200, 'the full amount they sent, not just the 1000 clipper-share half');
});

test('left to pay is budget minus paid, nothing more elaborate', async () => {
  const db = seed({ budget: 5000 });
  await recordClientPayment(db, { clientId: 1, campaignId: 1, amount: 1200, feePercent: 20 });

  const { billing } = await clientReq({ DB: db, SESSION_SECRET: SECRET }, '/api/client/campaigns/1').then(r => r.json());
  assert.equal(billing.paid, 1200);
  assert.equal(billing.left, 3800, '5000 budget - 1200 paid');
});

test('nothing paid yet: left to pay equals the full budget', async () => {
  const env = { DB: seed({ budget: 5000 }), SESSION_SECRET: SECRET };
  const { billing } = await clientReq(env, '/api/client/campaigns/1').then(r => r.json());
  assert.equal(billing.paid, 0);
  assert.equal(billing.left, 5000);
});

test('left to pay never goes negative, even if the client has paid more than the budget', async () => {
  const db = seed({ budget: 1000 });
  await recordClientPayment(db, { clientId: 1, campaignId: 1, amount: 5000, feePercent: 20 });
  const { billing } = await clientReq({ DB: db, SESSION_SECRET: SECRET }, '/api/client/campaigns/1').then(r => r.json());
  assert.equal(billing.left, 0, 'floored at 0, not a confusing negative number');
});

test('only paid and left ever cross the boundary -- no fee, wallet, or clipper-level money', async () => {
  const env = { DB: seed(), SESSION_SECRET: SECRET };
  await recordClientPayment(env.DB, { clientId: 1, campaignId: 1, amount: 1200, feePercent: 20 });
  const body = await clientReq(env, '/api/client/campaigns/1').then(r => r.json());

  assert.deepEqual(Object.keys(body.billing).sort(), ['left', 'paid']);
  const seen = JSON.stringify(body);
  for (const forbidden of ['fee_percent', 'fee_earned', 'fee_taken', 'management_fee', 'view_margin', 'wallet', 'locked_earning', '"earning"']) {
    assert.ok(!seen.includes(forbidden), `must never leak "${forbidden}" to a client`);
  }
});

test('an internal (non-billed) campaign shows no billing box at all', async () => {
  const env = { DB: seed({ kind: 'internal', feePercent: 0 }), SESSION_SECRET: SECRET };
  const { billing } = await clientReq(env, '/api/client/campaigns/1').then(r => r.json());
  assert.equal(billing, null);
});

test('billing is scoped per campaign -- a second campaign\'s payment never bleeds into this one\'s numbers', async () => {
  const db = seed();
  await db.prepare(
    `INSERT INTO campaigns (id, name, description, cpm, budget, status, created_at, model, min_views, allowed_platforms, campaign_kind, fee_percent)
     VALUES (2, 'Other', '', 50, 100000, 'active', ?, 'cpm', 100, 'instagram', 'client', 20)`
  ).bind(NOW).run();
  await recordClientPayment(db, { clientId: 1, campaignId: 2, amount: 5000, feePercent: 20 });

  const env = { DB: db, SESSION_SECRET: SECRET };
  const { billing } = await clientReq(env, '/api/client/campaigns/1').then(r => r.json());
  assert.equal(billing.paid, 0, 'campaign 2\'s payment must not show up on campaign 1');
});
