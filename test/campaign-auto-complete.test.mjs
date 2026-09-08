// A campaign completes itself automatically the instant remaining budget
// can't fund even one more full CPM unit for anyone -- confirmed explicitly
// by the founder, no admin click required. Reversible via a top-up (this
// ending was never a deliberate human decision); a manual "Mark Over"
// (completed_reason = 'manual') is never touched by budget math.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { allocateCampaignEarnings } from '../src/earnings.js';
import { buildAccountItems } from '../src/refresh-jobs.js';
import { topUpCampaignBudget } from '../src/finance.js';
import { handleClipper } from '../src/routes/clipper.js';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';

const SESSION_SECRET = 'test-secret';
async function clipperRequest(env, path) {
  const cookie = await createSessionCookie('clipper', 1, env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, { headers: { Cookie: cookie.split(';')[0] } });
  return handleClipper(request, env, new URL(request.url));
}
async function adminRequest(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('admin', 'admin', env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method, headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleAdmin(request, env, new URL(request.url));
}

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

function seed(budget) {
  return makeSqliteD1({
    clippers: [{ id: 1, username: 'c1', password_hash: 'h', password_salt: 's',
                 status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'T', cpm: 50, budget, status: 'active',
                  created_at: NOW, min_views: 1000, allowed_platforms: 'instagram',
                  campaign_kind: 'client', fee_percent: 20 }],
    submissions: [{ id: 1, clipper_id: 1, campaign_id: 1, platform: 'instagram',
                    ig_media_id: 'm1', permalink: 'p1', views: 3000, earning: 0,
                    status: 'active', eligible: 1, created_at: NOW, posted_at: NOW }]
  });
}

test('a campaign auto-completes once remaining budget cannot fund one more CPM unit', async () => {
  // 3,000 views bills 150, leaving remaining = 200 - 150 = 50 -- still one
  // full cpm(50) unit, should NOT complete yet.
  const db = seed(200);
  await allocateCampaignEarnings(db, 1);
  let c = await db.prepare('SELECT status, completed_reason FROM campaigns WHERE id = 1').first();
  assert.equal(c.status, 'active', 'remaining (50) still equals one full CPM unit');

  // Shrink the budget so remaining drops below cpm.
  await db.prepare('UPDATE campaigns SET budget = 170 WHERE id = 1').run();
  await allocateCampaignEarnings(db, 1);
  c = await db.prepare('SELECT status, completed_reason FROM campaigns WHERE id = 1').first();
  assert.equal(c.status, 'completed');
  assert.equal(c.completed_reason, 'budget_exhausted');
});

test('a top-up reopens an auto-completed campaign, but never a manually-ended one', async () => {
  const db = seed(170);
  await allocateCampaignEarnings(db, 1); // completes: remaining (20) < cpm (50)
  let c = await db.prepare('SELECT status FROM campaigns WHERE id = 1').first();
  assert.equal(c.status, 'completed');

  await topUpCampaignBudget(db, { campaignId: 1, amount: 60 }); // +48 to budget net of 20% fee
  await allocateCampaignEarnings(db, 1);
  c = await db.prepare('SELECT status, completed_reason FROM campaigns WHERE id = 1').first();
  assert.equal(c.status, 'active', 'reopened once remaining budget clears one CPM unit again');
  assert.equal(c.completed_reason, null);

  // A manual "Mark Over" must never be reopened by budget math.
  await db.prepare("UPDATE campaigns SET status = 'completed', completed_reason = 'manual' WHERE id = 1").run();
  await topUpCampaignBudget(db, { campaignId: 1, amount: 6000 });
  await allocateCampaignEarnings(db, 1);
  c = await db.prepare('SELECT status, completed_reason FROM campaigns WHERE id = 1').first();
  assert.equal(c.status, 'completed', 'a deliberate manual ending is not undone by adding budget');
  assert.equal(c.completed_reason, 'manual');
});

test('GET /api/clipper/campaigns keeps a completed campaign visible to a clipper who joined it, so the recap card can show', async () => {
  const db = seed(170);
  await db.prepare('INSERT INTO participations (clipper_id, campaign_id, status, joined_at) VALUES (1, 1, ?, ?)').bind('active', NOW).run();
  await allocateCampaignEarnings(db, 1); // auto-completes
  const env = { DB: db, SESSION_SECRET };

  const { campaigns } = await (await clipperRequest(env, '/api/clipper/campaigns')).json();
  const c = campaigns.find(x => x.id === 1);
  assert.ok(c, 'a joined, now-completed campaign must not disappear from the list');
  assert.equal(c.status, 'completed');
});

test('GET /api/clipper/campaigns hides a completed campaign from a clipper who never joined it', async () => {
  const db = seed(170);
  await allocateCampaignEarnings(db, 1); // auto-completes, clipper 1 never joined
  const env = { DB: db, SESSION_SECRET };

  const { campaigns } = await (await clipperRequest(env, '/api/clipper/campaigns')).json();
  assert.equal(campaigns.find(x => x.id === 1), undefined, 'never offered to browse/join once completed');
});

test('admin PATCH to status=completed ("Mark Over") sets completed_reason=manual, so budget math never auto-reopens it', async () => {
  const db = seed(170); // remaining would already be < cpm, i.e. eligible for auto-completion too
  const env = { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };

  const r = await adminRequest(env, '/api/admin/campaigns/1', { method: 'PATCH', body: { status: 'completed' } });
  assert.equal(r.status, 200);
  let c = await db.prepare('SELECT status, completed_reason FROM campaigns WHERE id = 1').first();
  assert.equal(c.status, 'completed');
  assert.equal(c.completed_reason, 'manual', 'a deliberate admin action, not the automatic budget-exhaustion reason');

  // Confirm it actually holds: even a real top-up must not reopen it.
  await topUpCampaignBudget(db, { campaignId: 1, amount: 6000 });
  await allocateCampaignEarnings(db, 1);
  c = await db.prepare('SELECT status, completed_reason FROM campaigns WHERE id = 1').first();
  assert.equal(c.status, 'completed');
  assert.equal(c.completed_reason, 'manual');
});

test('admin PATCH reopening a campaign (status=active) clears completed_reason', async () => {
  const db = seed(1000);
  await db.prepare("UPDATE campaigns SET status = 'completed', completed_reason = 'manual' WHERE id = 1").run();
  const env = { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };

  await adminRequest(env, '/api/admin/campaigns/1', { method: 'PATCH', body: { status: 'active' } });
  const c = await db.prepare('SELECT status, completed_reason FROM campaigns WHERE id = 1').first();
  assert.equal(c.status, 'active');
  assert.equal(c.completed_reason, null, 'no stale reason left behind once reopened');
});

test('admin PATCH that leaves status untouched does not disturb completed_reason', async () => {
  const db = seed(1000);
  await db.prepare("UPDATE campaigns SET status = 'completed', completed_reason = 'manual' WHERE id = 1").run();
  const env = { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };

  await adminRequest(env, '/api/admin/campaigns/1', { method: 'PATCH', body: { cpm: 60 } });
  const c = await db.prepare('SELECT status, completed_reason FROM campaigns WHERE id = 1').first();
  assert.equal(c.status, 'completed', 'unrelated edit does not touch status');
  assert.equal(c.completed_reason, 'manual', 'or the reason attached to it');
});

test('hide-recap requires the campaign to have actually ended, then dismisses the recap for everyone', async () => {
  const db = seed(1000);
  const env = { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };

  const early = await adminRequest(env, '/api/admin/campaigns/1/hide-recap', { method: 'POST' });
  assert.equal(early.status, 400, 'refuses on a still-active campaign');

  await db.prepare("UPDATE campaigns SET status = 'completed', completed_reason = 'manual' WHERE id = 1").run();
  const r = await adminRequest(env, '/api/admin/campaigns/1/hide-recap', { method: 'POST' });
  assert.equal(r.status, 200);
  const c = await db.prepare('SELECT recap_hidden_at FROM campaigns WHERE id = 1').first();
  assert.ok(c.recap_hidden_at, 'now set, so dashboard.html stops showing the recap card');
});

test('buildAccountItems excludes every submission on a completed campaign, even one inside its 7-day window', async () => {
  const db = seed(170);
  await allocateCampaignEarnings(db, 1); // auto-completes

  const account = {
    account_id: 1, platform: 'instagram', auto_import: 0, part_status: 'active',
    campaign_status: 'completed' // as loadAccount would now report it
  };
  const items = await buildAccountItems(db, account, { respectCooldown: false });
  assert.deepEqual(items, [], 'nothing offered for sync -- not the import leg, not any view leg');
});
