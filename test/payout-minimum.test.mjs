// clipgrow.in has advertised "Minimum payout Rs 500 -- balance rolls over"
// since launch: in the hero stat, the payout strip, the FAQ, and the FAQ
// structured data Google indexes. It was never implemented. A grep across
// src/, admin.html and dashboard.html found no payout-minimum constant or
// check of any kind, and db.js records that `min_payout` was deliberately
// dropped from the accepted campaign blueprint fields.
//
// So the site stated a payout rule the system could not honour, surface, or
// evidence -- which for a registering partnership is a representation it
// cannot stand behind. These tests make the published term real.
//
// The floor is deliberately NOT the same rule as a campaign's `min_views`
// write-off (writeOffAllBelowMin), which also talks about being "below min".
// That one closes a clip that never earned. This one holds back a transfer
// that is too small, without touching the clips -- the balance simply rolls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePayoutsDb } from './helpers/fake-payouts-db.mjs';
import { settlePayment, payableClips, PAYOUT_MINIMUM } from '../src/payouts.js';

const NOW = Date.now();

function campaign(o = {}) {
  return { id: 1, name: 'C', cpm: 100, min_views: 1000, budget: 1000000,
           blueprint_json: '{}', status: 'active', ...o };
}
function sub(o = {}) {
  // clipper_earning defaults to match earning (no margin gap) -- this suite
  // is about the payout minimum, not the fractional-margin mechanism.
  const earning = o.earning ?? 200;
  return {
    id: 1, clipper_id: 1, campaign_id: 1, account_id: null,
    permalink: 'https://x/1', views: 5000, earning, clipper_earning: earning,
    status: 'active', sync_error: null, source: 'manual', platform: 'instagram',
    duration_seconds: null, is_short: null, eligible: 1,
    created_at: NOW, posted_at: NOW, last_synced_at: NOW, last_ok_sync_at: NOW,
    locked_at: null, locked_earning: null, lock_reason: null, payment_id: null,
    frozen_earning: null, ...o
  };
}
const db = (subs) => makePayoutsDb({ campaigns: [campaign()], submissions: subs });

test('the advertised minimum is Rs 500', () => {
  assert.equal(PAYOUT_MINIMUM, 500, 'the site quotes this number in four places');
});

test('a payout under the minimum is refused, and nothing is locked', async () => {
  const d = db([sub({ id: 1, earning: 300 })]);

  const r = await settlePayment(d, { clipperId: 1, submissionIds: [1], amount: 300 });

  assert.equal(r.status, 409);
  assert.equal(r.below_minimum, true);
  assert.equal(r.payout_minimum, 500);
  assert.match(r.error, /rolls into the next run/);

  // The balance rolls over: the clip stays open and payable, exactly as the
  // site tells clippers it will.
  const clip = d._state.submissions.find(s => s.id === 1);
  assert.equal(clip.locked_at, null, 'nothing was locked');
  assert.equal(clip.earning, 300, 'and the earning is untouched');
  assert.equal((d._state.payments || []).length, 0, 'no payment row was written');
});

test('a payout exactly at the minimum goes through', async () => {
  const d = db([sub({ id: 1, earning: 500 })]);

  const r = await settlePayment(d, { clipperId: 1, submissionIds: [1], amount: 500 });

  assert.equal(r.ok, true);
  assert.equal(d._state.submissions[0].lock_reason, 'paid');
});

test('the minimum can be overridden deliberately', async () => {
  // A clipper leaving with Rs 300 owed should still be payable -- as an
  // explicit act, not by the rule quietly not existing.
  const d = db([sub({ id: 1, earning: 300 })]);

  const r = await settlePayment(d, {
    clipperId: 1, submissionIds: [1], amount: 300, allowBelowMinimum: true
  });

  assert.equal(r.ok, true);
  assert.equal(d._state.submissions[0].locked_earning, 300);
});

test('a write-off-only run is exempt: no cash is leaving', async () => {
  // Closing out clips that never reached the campaign's min_views transfers
  // nothing, so there is no payout to be under the minimum.
  const d = db([sub({ id: 1, views: 300, earning: 0 })]);

  const r = await settlePayment(d, { clipperId: 1, writeOffIds: [1], amount: 0 });

  assert.equal(r.ok, true);
  assert.equal(d._state.submissions[0].lock_reason, 'below_min');
});

test('payableClips reports the minimum and whether it is met', async () => {
  const under = await payableClips(db([sub({ id: 1, earning: 300 })]), 1, { days: 0 });
  assert.equal(under.totals.payout_minimum, 500);
  assert.equal(under.totals.payable_now, 300);
  assert.equal(under.totals.meets_minimum, false, 'the UI can warn before anything is clicked');

  const over = await payableClips(db([sub({ id: 1, earning: 900 })]), 1, { days: 0 });
  assert.equal(over.totals.meets_minimum, true);
});

test('the floor is on cash sent, not on what the clips are worth', async () => {
  // Clips worth Rs 800 but only Rs 300 actually transferred (the rest already
  // covered by an advance) is still a Rs 300 payout, and the site's promise is
  // about what lands in the clipper's account.
  const d = db([sub({ id: 1, earning: 800 })]);

  const r = await settlePayment(d, {
    clipperId: 1, submissionIds: [1], amount: 300, expectedClipsTotal: 800
  });

  assert.equal(r.status, 409);
  assert.equal(r.below_minimum, true);
});
