// The clipper is paid in complete CPM-multiples of the billable amount
// (`earning`, unchanged) -- never the billable amount itself. Whatever's
// left over becomes `clipper_earning`'s gap from `earning`, which
// src/payouts.js's settlePayment later realizes as a real 'view_margin'
// ledger entry. This file proves allocateCampaignEarnings computes that
// split correctly, and that it composes correctly with the existing,
// unchanged budget-clamping behavior (test/earning-math.test.mjs already
// proves a clip can be billable-clamped to a non-round amount like ₹90 --
// this file proves that ₹90 itself then floors correctly to a clean
// clipper payout, with the true remainder as margin).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { allocateCampaignEarnings } from '../src/earnings.js';
import { clipperFinancials, totalOutstanding } from '../src/db.js';
import { handleClipper } from '../src/routes/clipper.js';
import { createSessionCookie } from '../src/auth.js';

const SESSION_SECRET = 'test-secret';
async function clipperRequest(env, path) {
  const cookie = await createSessionCookie('clipper', 1, env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, { headers: { Cookie: cookie.split(';')[0] } });
  return handleClipper(request, env, new URL(request.url));
}

const NOW = Date.now();

const clipper = (id, o = {}) => ({
  id, username: 'c' + id, password_hash: 'h', password_salt: 's',
  status: 'active', created_at: NOW, ...o
});

const campaign = (o = {}) => ({
  id: 1, name: 'Test', description: '', cpm: 50, budget: 100000, status: 'active',
  created_at: NOW, model: 'cpm', min_views: 1000, allowed_platforms: 'instagram', ...o
});

const sub = (id, clipperId, views, o = {}) => ({
  id, clipper_id: clipperId, campaign_id: 1, platform: 'instagram',
  ig_media_id: 'm' + id, permalink: 'p' + id, views, earning: 0, clipper_earning: null,
  status: 'active', eligible: 1, created_at: NOW, ...o
});

function seed({ clippers, submissions, campaignOverrides = {} }) {
  return makeSqliteD1({ clippers, campaigns: [campaign(campaignOverrides)], submissions });
}

test('a clip whose billable earning is an exact CPM multiple has no margin', async () => {
  // 3,000 views at ₹50 = ₹150 billed. 150 / 50 = exactly 3 -- no remainder.
  const db = seed({ clippers: [clipper(1)], submissions: [sub(1, 1, 3000)] });
  await allocateCampaignEarnings(db, 1);
  const row = await db.prepare('SELECT earning, clipper_earning FROM submissions WHERE id = 1').first();
  assert.equal(row.earning, 150);
  assert.equal(row.clipper_earning, 150, 'no margin when the math already aligns');
});

test('a mid-block clip pays the clipper the CPM floor, margin gets the rest', async () => {
  // 1,500 views at ₹50 = ₹75 billed. Floor(75/50)*50 = 50 to the clipper, ₹25 margin.
  const db = seed({ clippers: [clipper(1)], submissions: [sub(1, 1, 1500)] });
  await allocateCampaignEarnings(db, 1);
  const row = await db.prepare('SELECT earning, clipper_earning FROM submissions WHERE id = 1').first();
  assert.equal(row.earning, 75, 'billable stays exact CPM math, unchanged');
  assert.equal(row.clipper_earning, 50);
  assert.equal(row.earning - row.clipper_earning, 25, 'the margin');
});

test('a budget-clamped clip still floors correctly on the clamped amount', async () => {
  // A clip worth ₹400 by views, but only ₹90 of budget remains. The existing
  // clamp (unchanged, tested in earning-math.test.mjs) gives it ₹90 billable.
  // The clipper then gets floor(90/50)*50 = ₹50, margin ₹40.
  const db = seed({
    clippers: [clipper(1), clipper(2)],
    submissions: [
      // Clipper 1 eats 9,910 of the budget first (FCFS by created_at), leaving
      // exactly 90 for clipper 2's clip.
      sub(1, 1, 1000 * (9910 / 50), { created_at: NOW - 1000 }),
      sub(2, 2, 8000, { created_at: NOW })
    ],
    campaignOverrides: { budget: 10000 }
  });
  await allocateCampaignEarnings(db, 1);
  const row = await db.prepare('SELECT earning, clipper_earning FROM submissions WHERE id = 2').first();
  assert.equal(row.earning, 90, 'clamped by the remaining budget, unchanged behavior');
  assert.equal(row.clipper_earning, 50);
  assert.equal(row.earning - row.clipper_earning, 40, 'the budget-boundary case captures margin the same way');
});

test('a locked clip is never touched by a later allocation pass', async () => {
  const db = seed({
    clippers: [clipper(1)],
    submissions: [sub(1, 1, 1500, {
      locked_at: NOW - 1000, locked_earning: 999, clipper_earning: 999, earning: 999, lock_reason: 'paid'
    })]
  });
  await allocateCampaignEarnings(db, 1);
  const row = await db.prepare('SELECT earning, clipper_earning, locked_earning FROM submissions WHERE id = 1').first();
  assert.equal(row.locked_earning, 999, 'financial history, untouched');
  assert.equal(row.clipper_earning, 999, 'never recomputed once locked');
  assert.equal(row.earning, 999, 'never recomputed once locked');
});

test('clipperFinancials().pending and totalOutstanding() reflect what the clipper is owed, not the billable figure', async () => {
  const db = seed({ clippers: [clipper(1)], submissions: [sub(1, 1, 1500)] }); // billed 75, clipper owed 50
  await allocateCampaignEarnings(db, 1);

  const fin = await clipperFinancials(db, 1);
  assert.equal(fin.earned, 75, 'earned stays the billable/delivered figure -- a genuinely different question');
  assert.equal(fin.pending, 50, 'pending is what the clipper is actually owed');
  assert.equal(fin.owed, 50);

  const outstanding = await totalOutstanding(db);
  assert.equal(outstanding, 50, 'agrees with the per-clipper figure, not the billable one');
});

test('clipperFinancials().clipper_earned is the real total, distinct from the billable "earned"', async () => {
  const db = seed({
    clippers: [clipper(1)],
    submissions: [
      sub(1, 1, 1500), // live: billed 75, clipper 50
      sub(2, 1, 1500, { locked_at: NOW - 1000, locked_earning: 999, clipper_earning: 999, earning: 999 }) // settled history
    ]
  });
  await allocateCampaignEarnings(db, 1);
  const fin = await clipperFinancials(db, 1);
  assert.equal(fin.earned, 999 + 75, 'the billable/delivered total -- an admin question');
  assert.equal(fin.clipper_earned, 999 + 50, 'settled (untouched) + pending (clipper-owed) -- the clipper\'s real total');
});

test('GET /api/clipper/submissions shows the clipper figure as "earning", with the billable one alongside', async () => {
  const db = seed({ clippers: [clipper(1)], submissions: [sub(1, 1, 1500)] }); // billed 75, clipper owed 50
  await allocateCampaignEarnings(db, 1);
  const env = { DB: db, SESSION_SECRET };

  const { clips } = await (await clipperRequest(env, '/api/clipper/submissions')).json();
  assert.equal(clips[0].earning, 50, 'never the billable figure -- a clipper screen must never lead with more than they get');
  assert.equal(clips[0].billed_earning, 75);
  assert.match(clips[0].why_text, /₹50 earned so far/);
});

test('GET /api/clipper/submissions shows a locked clip\'s frozen settlement, not a recomputed figure', async () => {
  const db = seed({
    clippers: [clipper(1)],
    submissions: [sub(1, 1, 1500, { locked_at: NOW - 1000, locked_earning: 999, clipper_earning: 999, earning: 999, lock_reason: 'paid' })]
  });
  const env = { DB: db, SESSION_SECRET };
  const { clips } = await (await clipperRequest(env, '/api/clipper/submissions')).json();
  assert.equal(clips[0].earning, 999);
  assert.equal(clips[0].billed_earning, null, 'a locked clip has no separate billable figure to show -- it is closed');
});
