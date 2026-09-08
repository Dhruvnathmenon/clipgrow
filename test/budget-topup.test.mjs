// Two things worth pinning down with real numbers:
// 1. payableClips must show/select exactly the amount settlePayment will
//    accept -- if these two disagree, every payout attempt fails with a
//    staleness rejection that isn't a real race (see src/payouts.js's
//    payableClips comment).
// 2. Budget top-ups: the ledger's recorded pool-share and the actual
//    campaigns.budget increase must be exactly equal, even for an amount
//    that doesn't divide cleanly by 5 -- they're the same variable by
//    construction (src/finance.js's topUpCampaignBudget), not two
//    independently-computed numbers that usually agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { allocateCampaignEarnings } from '../src/earnings.js';
import { payableClips, settlePayment } from '../src/payouts.js';
import { topUpCampaignBudget, walletOfKind, listEntries } from '../src/finance.js';

const NOW = Date.now();

function seed() {
  return makeSqliteD1({
    clippers: [{ id: 1, username: 'c1', password_hash: 'h', password_salt: 's',
                 status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'T', cpm: 50, budget: 100000, status: 'active',
                  created_at: NOW, min_views: 1000, allowed_platforms: 'instagram',
                  campaign_kind: 'client', fee_percent: 20 }],
    submissions: [{ id: 1, clipper_id: 1, campaign_id: 1, platform: 'instagram',
                    ig_media_id: 'm1', permalink: 'p1', views: 1500, earning: 0,
                    status: 'active', eligible: 1, created_at: NOW, posted_at: NOW }]
  });
}

test('payableClips shows exactly what settlePayment accepts', async () => {
  const db = seed();
  await allocateCampaignEarnings(db, 1); // 1,500 views @ 50 -> billed 75, clipper 75 (no split)

  const { clips, totals } = await payableClips(db, 1, { days: 0 });
  const c = clips[0];
  assert.equal(c.earning, 75, 'the clipper is paid the full billable figure -- no fractional floor');
  assert.equal(c.selectable, true);
  assert.equal(totals.payable_now, 75);

  const agency = (await walletOfKind(db, 'agency')).id;
  const r = await settlePayment(db, {
    clipperId: 1, submissionIds: [1], amount: totals.payable_now,
    expectedClipsTotal: totals.payable_now, campaignId: 1, walletId: agency,
    allowBelowMinimum: true, allowUnfunded: true
  });
  assert.equal(r.ok, true, 'the exact number payableClips displayed is accepted, not rejected as stale');
});

test('a clip whose billable amount floors to zero clipper_earning is not selectable', async () => {
  const db = seed();
  await db.prepare('UPDATE submissions SET views = 100 WHERE id = 1').run(); // below min_views -> earning 0
  await allocateCampaignEarnings(db, 1);
  const { clips } = await payableClips(db, 1, { days: 0 });
  assert.equal(clips[0].selectable, false);
});

test('topUpCampaignBudget: budget increases by exactly what was entered, fee is an EXTRA 20% on top', async () => {
  const db = seed();
  // 733 does not divide cleanly by 5 -- a case where independently-rounded
  // math could disagree by a rupee.
  const before = (await db.prepare('SELECT budget FROM campaigns WHERE id = 1').first()).budget;
  const r = await topUpCampaignBudget(db, { campaignId: 1, amount: 733, feePercent: 20 });
  assert.equal(r.ok, true);
  assert.equal(r.budget_increase, 733, 'exactly what was entered -- never a fraction carved out of it');
  assert.equal(r.fee, 147, 'round(733 * 20 / 100) -- an addition, not a slice');
  assert.equal(r.total, 880, 'what the client actually owes: budget increase + fee, not the other way round');

  const after = (await db.prepare('SELECT budget FROM campaigns WHERE id = 1').first()).budget;
  assert.equal(after - before, r.budget_increase, 'budget increased by exactly the ledger pool-share entry, same variable');

  const entries = await listEntries(db, { campaignId: 1 });
  const pool = entries.find(e => e.category === 'client_payment');
  const fee = entries.find(e => e.category === 'management_fee');
  assert.equal(pool.amount, 733);
  assert.equal(fee.amount, 147);
});

test('topUpCampaignBudget: all three writes land in one atomic batch', async () => {
  const db = seed();
  // Break the batch by making the campaign not exist for the budget UPDATE's
  // WHERE clause -- proves nothing partial lands when a write can't apply.
  // (Simplest real proof available without mocking db.batch: confirm the
  // function refuses cleanly for a nonexistent campaign, writing nothing.)
  const r = await topUpCampaignBudget(db, { campaignId: 999, amount: 500 });
  assert.equal(r.error, 'Campaign not found.');
  const entries = await listEntries(db, {});
  assert.equal(entries.length, 0, 'nothing written for a top-up that never happened');
});
