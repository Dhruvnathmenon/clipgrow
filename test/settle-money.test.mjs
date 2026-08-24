// Guards the money-handling defects found by auditing settlePayment: a clip
// could be locked at a figure the admin never saw, and a concurrent settle
// could leave a second payment row in the ledger for money transferred once.
//
// These paths had almost no coverage before -- one happy-path settle test and
// nothing at all for reversePayment -- which is exactly why the defects sat
// unnoticed in code that moves real rupees.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePayoutsDb } from './helpers/fake-payouts-db.mjs';
import { settlePayment, reversePayment } from '../src/payouts.js';

function campaign(o = {}) {
  return { id: 1, name: 'C', cpm: 40, min_views: 1000, budget: 1000000, blueprint_json: '{}', status: 'active', ...o };
}
function sub(o = {}) {
  const now = Date.now();
  return {
    id: 1, clipper_id: 1, campaign_id: 1, account_id: null,
    permalink: 'https://x/1', views: 5000, earning: 200,
    status: 'active', sync_error: null, source: 'manual', platform: 'instagram',
    duration_seconds: null, is_short: null, eligible: 1,
    created_at: now, posted_at: now, last_synced_at: now, last_ok_sync_at: now,
    locked_at: null, locked_earning: null, lock_reason: null, payment_id: null,
    ...o
  };
}

test('settlePayment: refuses when the clips are now worth more than the page showed', async () => {
  // Admin loaded the page when the clip was worth 120; a refresh has since
  // repriced it to 360. Paying now would transfer 120 and lock it at 360.
  const db = makePayoutsDb({ campaigns: [campaign()], submissions: [sub({ id: 7, earning: 360 })] });

  const r = await settlePayment(db, {
    clipperId: 1, submissionIds: [7], amount: 120, expectedClipsTotal: 120
  });

  assert.equal(r.status, 409, 'must refuse a stale settle');
  assert.equal(r.actual, 360);
  assert.equal(r.expected, 120);

  const s = db._state.submissions.find(x => x.id === 7);
  assert.equal(s.locked_at, null, 'clip must NOT be locked');
  assert.equal(db._state.payments.length, 0, 'no payment may be recorded');
});

test('settlePayment: proceeds when the page total still matches the server', async () => {
  const db = makePayoutsDb({ campaigns: [campaign()], submissions: [sub({ id: 7, earning: 360 })] });

  const r = await settlePayment(db, {
    clipperId: 1, submissionIds: [7], amount: 360, expectedClipsTotal: 360
  });

  assert.equal(r.ok, true);
  assert.equal(r.paid_clips, 1);
  const s = db._state.submissions.find(x => x.id === 7);
  assert.equal(s.lock_reason, 'paid');
  assert.equal(s.locked_earning, 360);
});

test('settlePayment: an omitted expected total still settles, so an older page keeps working', async () => {
  const db = makePayoutsDb({ campaigns: [campaign()], submissions: [sub({ id: 7, earning: 200 })] });
  const r = await settlePayment(db, { clipperId: 1, submissionIds: [7], amount: 200 });
  assert.equal(r.ok, true);
});

test('settlePayment: a clip locked mid-flight records no payment and leaves no phantom row', async () => {
  const db = makePayoutsDb({ campaigns: [campaign()], submissions: [sub({ id: 7, earning: 200 })] });

  // Simulate a concurrent settle winning the race: the row is read as unlocked
  // during validation, then locked before our UPDATE lands.
  const realPrepare = db.prepare.bind(db);
  let armed = true;
  db.prepare = (sql) => {
    if (armed && /^UPDATE submissions SET locked_at = \?, locked_earning = \?/.test(sql)) {
      armed = false;
      const other = db._state.submissions.find(x => x.id === 7);
      Object.assign(other, { locked_at: Date.now(), locked_earning: 200, lock_reason: 'paid', payment_id: 99 });
    }
    return realPrepare(sql);
  };

  const r = await settlePayment(db, { clipperId: 1, submissionIds: [7], amount: 200 });

  assert.equal(r.status, 409, 'must report the conflict rather than returning ok');
  assert.equal(db._state.payments.length, 0, 'the payment row must be rolled back, not left in the ledger');
});

test('reversePayment: unlocks the clips it settled and clears their payment link', async () => {
  const ts = Date.now();
  const db = makePayoutsDb({
    campaigns: [campaign()],
    submissions: [
      sub({ id: 1, earning: 200, locked_at: ts, locked_earning: 200, lock_reason: 'paid', payment_id: 5 }),
      sub({ id: 2, earning: 300, locked_at: ts, locked_earning: 300, lock_reason: 'paid', payment_id: 5 })
    ],
    payments: [{ id: 5, clipper_id: 1, campaign_id: 1, amount: 500, paid_at: ts }]
  });

  const r = await reversePayment(db, 5);
  assert.equal(r.ok, true);
  assert.equal(r.unlocked_clips, 2);
  for (const id of [1, 2]) {
    const s = db._state.submissions.find(x => x.id === id);
    assert.equal(s.locked_at, null, `clip ${id} must be unlocked`);
    assert.equal(s.payment_id, null, `clip ${id} must lose its payment link`);
  }
  assert.equal(db._state.payments.length, 0, 'the payment row must be gone');
});

test('reversePayment: a second reversal of the same payment is refused, not silently repeated', async () => {
  const ts = Date.now();
  const db = makePayoutsDb({
    campaigns: [campaign()],
    submissions: [sub({ id: 1, locked_at: ts, locked_earning: 200, lock_reason: 'paid', payment_id: 5 })],
    payments: [{ id: 5, clipper_id: 1, campaign_id: 1, amount: 200, paid_at: ts }]
  });

  assert.equal((await reversePayment(db, 5)).ok, true);
  assert.equal((await reversePayment(db, 5)).status, 404);
});

test('reversePayment: never reopens a clip closed for a different reason', async () => {
  const ts = Date.now();
  const db = makePayoutsDb({
    campaigns: [campaign()],
    submissions: [
      sub({ id: 1, earning: 200, locked_at: ts, locked_earning: 200, lock_reason: 'paid', payment_id: 5 }),
      // Written off in the same settlement: locked, but carries no payment_id.
      sub({ id: 2, views: 100, earning: 0, locked_at: ts, locked_earning: 0, lock_reason: 'below_min', payment_id: null })
    ],
    payments: [{ id: 5, clipper_id: 1, campaign_id: 1, amount: 200, paid_at: ts }]
  });

  await reversePayment(db, 5);
  const off = db._state.submissions.find(x => x.id === 2);
  assert.equal(off.lock_reason, 'below_min', 'a write-off must stay closed');
});

test('a rolled-back settle also releases the write-offs it locked, not just the paid clips', async () => {
  // The write-off statements deliberately set no payment_id, so a rollback
  // scoped to payment_id left them permanently locked at zero while the API
  // reported that nothing had been charged.
  const db = makePayoutsDb({
    campaigns: [campaign()],
    submissions: [
      sub({ id: 7, earning: 200 }),                        // to pay
      sub({ id: 8, views: 100, earning: 0 })               // to write off
    ]
  });

  // A concurrent settle grabs clip 7 between validation and the batch.
  const realPrepare = db.prepare.bind(db);
  let armed = true;
  db.prepare = (sql) => {
    if (armed && /^UPDATE submissions SET locked_at = \?, locked_earning = \?/.test(sql)) {
      armed = false;
      Object.assign(db._state.submissions.find(x => x.id === 7),
        { locked_at: Date.now(), locked_earning: 200, lock_reason: 'paid', payment_id: 99 });
    }
    return realPrepare(sql);
  };

  const r = await settlePayment(db, {
    clipperId: 1, submissionIds: [7], writeOffIds: [8], amount: 200
  });

  assert.equal(r.status, 409, 'must report the conflict');
  assert.equal(db._state.payments.length, 0, 'no payment row may survive');

  const off = db._state.submissions.find(x => x.id === 8);
  assert.equal(off.locked_at, null, 'the write-off must be released, not orphaned');
  assert.equal(off.lock_reason, null, 'and must not stay closed at zero');
});
