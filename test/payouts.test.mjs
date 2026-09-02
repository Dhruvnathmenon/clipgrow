// Proves the automatic below-minimum write-off logic: a clip is only ever
// closed once it has actually been checked and genuinely fell short, never
// because it simply hasn't been synced yet -- and the payout window itself
// is now the only "grace period" a clip gets (no separate 30-day timer).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePayoutsDb } from './helpers/fake-payouts-db.mjs';
import { payableClips, settlePayment, writeOffAllBelowMin } from '../src/payouts.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function campaign(overrides = {}) {
  return { id: 1, name: 'Test Campaign', cpm: 40, min_views: 1000, budget: 1000000, blueprint_json: '{}', status: 'active', ...overrides };
}

function sub(overrides = {}) {
  const now = Date.now();
  return {
    id: 1, clipper_id: 1, campaign_id: 1, account_id: null,
    permalink: 'https://instagram.com/reel/x', views: 0, earning: 0,
    status: 'active', sync_error: null, source: 'manual', platform: 'instagram',
    duration_seconds: null, is_short: null, eligible: 1,
    created_at: now, posted_at: now, last_synced_at: null, last_ok_sync_at: null,
    locked_at: null, locked_earning: null, lock_reason: null, payment_id: null,
    ...overrides
  };
}

function payment(overrides = {}) {
  return { id: 1, clipper_id: 1, campaign_id: 1, amount: 100, paid_at: Date.now(), ...overrides };
}

// -------------------------------------------------------------- payableClips

test('payableClips: a clip that has never been synced is NOT below_min, even with 0 views under the minimum', async () => {
  const db = makePayoutsDb({
    campaigns: [campaign()],
    submissions: [sub({ id: 1, views: 0, last_ok_sync_at: null })]
  });
  const { clips } = await payableClips(db, 1, { days: 0 });
  assert.equal(clips[0].below_min, false, 'a never-synced clip must not read as below_min');
  assert.equal(clips[0].write_off_due, false);
});

test('payableClips: a clip that was actually checked and fell short IS below_min and write_off_due, regardless of age', async () => {
  const now = Date.now();
  const db = makePayoutsDb({
    campaigns: [campaign()],
    submissions: [sub({ id: 1, views: 300, last_ok_sync_at: now - DAY_MS, posted_at: now - DAY_MS })] // posted yesterday
  });
  const { clips } = await payableClips(db, 1, { days: 0 });
  assert.equal(clips[0].below_min, true);
  assert.equal(clips[0].write_off_due, true, 'no 30-day wait required any more -- the payout window is the grace period');
});

test('payableClips: disqualified, paused, and ineligible clips never count as below_min even if under the threshold', async () => {
  const now = Date.now();
  const db = makePayoutsDb({
    campaigns: [campaign()],
    submissions: [
      sub({ id: 1, status: 'disqualified', views: 100, last_ok_sync_at: now }),
      sub({ id: 2, status: 'paused', views: 100, last_ok_sync_at: now }),
      sub({ id: 3, eligible: 0, views: 100, last_ok_sync_at: now })
    ]
  });
  const { clips } = await payableClips(db, 1, { days: 0 });
  for (const c of clips) assert.equal(c.below_min, false, `submission ${c.id} must not be below_min`);
});

// ---------------------------------------------------------- writeOffAllBelowMin
//
// The sweep only ever closes a clip whose clipper already had a payout that
// should have covered it (a settled payment dated on/after the clip was
// posted). A clip still waiting on its clipper's first-ever payout is left
// alone -- it may still clear the minimum before that payout actually runs.

test('writeOffAllBelowMin: closes a below-minimum clip that a past payout already should have covered', async () => {
  const now = Date.now();
  const db = makePayoutsDb({
    campaigns: [campaign()],
    submissions: [sub({ id: 1, views: 400, last_ok_sync_at: now, earning: 0, posted_at: now - 10 * DAY_MS })],
    payments: [payment({ paid_at: now - 5 * DAY_MS })] // ran after this clip was posted
  });
  const result = await writeOffAllBelowMin(db);
  assert.equal(result.closed, 1);
  assert.deepEqual(result.campaigns, [1]);

  const s = db._state.submissions[0];
  assert.ok(s.locked_at, 'clip is now locked');
  assert.equal(s.locked_earning, 0);
  assert.equal(s.lock_reason, 'below_min');
  assert.equal(s.earning, 0);
});

test('writeOffAllBelowMin: never touches a below-minimum clip whose clipper has never had ANY payout yet', async () => {
  const now = Date.now();
  const db = makePayoutsDb({
    campaigns: [campaign()],
    submissions: [sub({ id: 1, views: 400, last_ok_sync_at: now })]
    // no payments at all
  });
  const result = await writeOffAllBelowMin(db);
  assert.equal(result.closed, 0, 'nothing to sweep until a first payout has actually run for this clipper');
  assert.equal(db._state.submissions[0].locked_at, null);
});

test('writeOffAllBelowMin: never touches a clip posted AFTER the clipper\'s last payout -- it may still clear the minimum before the next one', async () => {
  const now = Date.now();
  const db = makePayoutsDb({
    campaigns: [campaign()],
    submissions: [sub({ id: 1, views: 400, last_ok_sync_at: now, posted_at: now - 1 * DAY_MS })], // posted yesterday
    payments: [payment({ paid_at: now - 10 * DAY_MS })] // last payout ran 10 days ago, before this clip existed
  });
  const result = await writeOffAllBelowMin(db);
  assert.equal(result.closed, 0, 'this clip is still in the clipper\'s current, not-yet-paid-out window');
  assert.equal(db._state.submissions[0].locked_at, null);
});

test('writeOffAllBelowMin: an all-campaigns payment (campaign_id null) still counts as a prior payout for every campaign', async () => {
  const now = Date.now();
  const db = makePayoutsDb({
    campaigns: [campaign()],
    submissions: [sub({ id: 1, views: 400, last_ok_sync_at: now, posted_at: now - 10 * DAY_MS })],
    payments: [payment({ campaign_id: null, paid_at: now - 5 * DAY_MS })]
  });
  const result = await writeOffAllBelowMin(db);
  assert.equal(result.closed, 1, 'an all-campaigns settlement still closes out a covered campaign\'s stragglers');
});

test('writeOffAllBelowMin: a payment for a DIFFERENT clipper does not make this clipper\'s clip sweepable', async () => {
  const now = Date.now();
  const db = makePayoutsDb({
    campaigns: [campaign()],
    submissions: [sub({ id: 1, clipper_id: 1, views: 400, last_ok_sync_at: now, posted_at: now - 10 * DAY_MS })],
    payments: [payment({ clipper_id: 2, paid_at: now - 5 * DAY_MS })]
  });
  const result = await writeOffAllBelowMin(db);
  assert.equal(result.closed, 0);
});

test('writeOffAllBelowMin: never touches a clip that has not been synced yet, even with a covering prior payout', async () => {
  const now = Date.now();
  const db = makePayoutsDb({
    campaigns: [campaign()],
    submissions: [sub({ id: 1, views: 0, last_ok_sync_at: null, posted_at: now - 10 * DAY_MS })],
    payments: [payment({ paid_at: now - 5 * DAY_MS })]
  });
  const result = await writeOffAllBelowMin(db);
  assert.equal(result.closed, 0);
  assert.equal(db._state.submissions[0].locked_at, null, 'an unsynced clip must be left completely alone');
});

test('writeOffAllBelowMin: never touches a clip that already qualifies and is earning money', async () => {
  const now = Date.now();
  const db = makePayoutsDb({
    campaigns: [campaign()],
    submissions: [sub({ id: 1, views: 5000, last_ok_sync_at: now, earning: 200, posted_at: now - 10 * DAY_MS })],
    payments: [payment({ paid_at: now - 5 * DAY_MS })]
  });
  const result = await writeOffAllBelowMin(db);
  assert.equal(result.closed, 0);
  assert.equal(db._state.submissions[0].earning, 200, 'a qualifying clip must keep its earning untouched');
});

test('writeOffAllBelowMin: never re-locks a clip that is already locked (paid or previously written off)', async () => {
  const now = Date.now();
  const db = makePayoutsDb({
    campaigns: [campaign()],
    submissions: [sub({ id: 1, views: 400, last_ok_sync_at: now, posted_at: now - 10 * DAY_MS, locked_at: now - DAY_MS, locked_earning: 0, lock_reason: 'below_min' })],
    payments: [payment({ paid_at: now - 5 * DAY_MS })]
  });
  const result = await writeOffAllBelowMin(db);
  assert.equal(result.closed, 0, 'an already-locked clip is not part of the sweep');
});

test('writeOffAllBelowMin: is idempotent -- a second run closes nothing further', async () => {
  const now = Date.now();
  const db = makePayoutsDb({
    campaigns: [campaign()],
    submissions: [sub({ id: 1, views: 400, last_ok_sync_at: now, posted_at: now - 10 * DAY_MS })],
    payments: [payment({ paid_at: now - 5 * DAY_MS })]
  });
  const first = await writeOffAllBelowMin(db);
  const second = await writeOffAllBelowMin(db);
  assert.equal(first.closed, 1);
  assert.equal(second.closed, 0);
});

test('writeOffAllBelowMin: campaign/clipper filters scope the sweep correctly', async () => {
  const now = Date.now();
  const db = makePayoutsDb({
    campaigns: [campaign({ id: 1 }), campaign({ id: 2 })],
    submissions: [
      sub({ id: 1, clipper_id: 1, campaign_id: 1, views: 400, last_ok_sync_at: now, posted_at: now - 10 * DAY_MS }),
      sub({ id: 2, clipper_id: 2, campaign_id: 2, views: 400, last_ok_sync_at: now, posted_at: now - 10 * DAY_MS })
    ],
    payments: [payment({ id: 1, clipper_id: 1, campaign_id: 1, paid_at: now - 5 * DAY_MS }), payment({ id: 2, clipper_id: 2, campaign_id: 2, paid_at: now - 5 * DAY_MS })]
  });
  const result = await writeOffAllBelowMin(db, { campaignId: 1 });
  assert.equal(result.closed, 1);
  assert.ok(db._state.submissions.find(s => s.id === 1).locked_at, 'campaign 1 clip closed');
  assert.equal(db._state.submissions.find(s => s.id === 2).locked_at, null, 'campaign 2 clip left alone');
});

test('writeOffAllBelowMin: multiple below-min, payout-covered clips across different campaigns are all closed in one sweep, unscoped', async () => {
  const now = Date.now();
  const db = makePayoutsDb({
    campaigns: [campaign({ id: 1 }), campaign({ id: 2 })],
    submissions: [
      sub({ id: 1, clipper_id: 1, campaign_id: 1, views: 400, last_ok_sync_at: now, posted_at: now - 10 * DAY_MS }),
      sub({ id: 2, clipper_id: 2, campaign_id: 2, views: 100, last_ok_sync_at: now, posted_at: now - 10 * DAY_MS }),
      sub({ id: 3, clipper_id: 3, campaign_id: 2, views: 9000, last_ok_sync_at: now, earning: 300, posted_at: now - 10 * DAY_MS }) // stays open
    ],
    payments: [
      payment({ id: 1, clipper_id: 1, campaign_id: 1, paid_at: now - 5 * DAY_MS }),
      payment({ id: 2, clipper_id: 2, campaign_id: 2, paid_at: now - 5 * DAY_MS }),
      payment({ id: 3, clipper_id: 3, campaign_id: 2, paid_at: now - 5 * DAY_MS })
    ]
  });
  const result = await writeOffAllBelowMin(db);
  assert.equal(result.closed, 2);
  assert.deepEqual(result.campaigns.sort(), [1, 2]);
  assert.equal(db._state.submissions.find(s => s.id === 3).locked_at, null, 'the qualifying clip is untouched');
});

// -------------------------------------------------------------- settlePayment
// Regression coverage: the manual write-off path settlePayment already had is
// unaffected by the automatic-eligibility change above.

test('settlePayment: still pays selected clips and write-offs explicitly-selected clips together, in one settlement', async () => {
  const now = Date.now();
  const db = makePayoutsDb({
    campaigns: [campaign({ budget: 100000 })],
    submissions: [
      sub({ id: 1, clipper_id: 1, campaign_id: 1, views: 5000, earning: 200, last_ok_sync_at: now }),
      sub({ id: 2, clipper_id: 1, campaign_id: 1, views: 300, earning: 0, last_ok_sync_at: now })
    ]
  });
  const result = await settlePayment(db, {
    // Rs 200 is below the Rs 500 payout floor; this test is about pairing a
    // payment with a write-off, not about the minimum, so it opts out.
    clipperId: 1, submissionIds: [1], writeOffIds: [2], amount: 200, campaignId: 1,
    allowBelowMinimum: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.paid_clips, 1);
  assert.equal(result.written_off_clips, 1);

  const paid = db._state.submissions.find(s => s.id === 1);
  const off = db._state.submissions.find(s => s.id === 2);
  assert.equal(paid.lock_reason, 'paid');
  assert.equal(paid.locked_earning, 200);
  assert.equal(off.lock_reason, 'below_min');
  assert.equal(off.locked_earning, 0);
});
