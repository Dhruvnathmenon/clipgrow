// A clipper payout must appear exactly once in the ledger, linked to the
// payment it mirrors, and must stop counting the moment that payment is
// reversed. Recorded in two places without a link is how a ledger quietly
// double-counts the largest outflow the business has.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { settlePayment, reversePayment } from '../src/payouts.js';
import { walletBalances, listEntries, walletOfKind, agencyPnL, addEntry } from '../src/finance.js';

const NOW = Date.now();

function seed() {
  return makeSqliteD1({
    clippers: [{ id: 1, username: 'ravi', display_name: 'Ravi',
                 password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }],
    campaigns: [{ id: 7, name: 'Acme', cpm: 40, budget: 1000000, status: 'active',
                  created_at: NOW, min_views: 1000, allowed_platforms: 'instagram',
                  campaign_kind: 'client', fee_percent: 20 }],
    submissions: [{ id: 101, clipper_id: 1, campaign_id: 7, platform: 'instagram',
                    ig_media_id: 'm1', permalink: 'p1', views: 200000, earning: 8000,
                    // 8000 is already an exact multiple of cpm 40 -- no margin gap,
                    // this file is about ledger linkage, not the margin mechanism.
                    clipper_earning: 8000,
                    status: 'active', eligible: 1, created_at: NOW, posted_at: NOW,
                    last_ok_sync_at: NOW }]
  });
}

test('settling from a wallet writes exactly one linked ledger entry', async () => {
  const db = seed();
  const agency = (await walletOfKind(db, 'agency')).id;
  // Fund the wallet first: you cannot pay out of an empty account.
  await addEntry(db, { direction: 'in', amount: 40000, wallet_id: agency,
                       category: 'client_payment', campaign_id: 7 });

  const r = await settlePayment(db, {
    clipperId: 1, submissionIds: [101], amount: 8000, campaignId: 7, walletId: agency
  });
  assert.equal(r.ok, true);

  const rows = (await listEntries(db, {})).filter(r => r.category === 'clipper_payout');
  assert.equal(rows.length, 1, 'the payout is recorded once, not twice');
  assert.equal(rows[0].category, 'clipper_payout');
  assert.equal(rows[0].amount, 8000);
  assert.equal(rows[0].clipper_id, 1);
  assert.equal(rows[0].campaign_id, 7);
  assert.ok(rows[0].payment_id, 'linked to the payment it mirrors');

  const ws = await walletBalances(db);
  assert.equal(ws.find(w => w.kind === 'agency').balance, 32000,
    'the payout came out of the working account');
});

test('reversing the payment voids the ledger entry rather than deleting it', async () => {
  const db = seed();
  const agency = (await walletOfKind(db, 'agency')).id;
  // Fund the wallet first: you cannot pay out of an empty account.
  await addEntry(db, { direction: 'in', amount: 40000, wallet_id: agency,
                       category: 'client_payment', campaign_id: 7 });
  await settlePayment(db, {
    clipperId: 1, submissionIds: [101], amount: 8000, campaignId: 7, walletId: agency
  });

  const paymentId = db._rows('payments')[0].id;
  await reversePayment(db, paymentId);

  const live = (await listEntries(db, {})).filter(r => r.category === 'clipper_payout');
  assert.equal(live.length, 0, 'no longer counted');
  const all = (await listEntries(db, { includeVoid: true })).filter(r => r.category === 'clipper_payout');
  assert.equal(all.length, 1, 'but still on the record');
  assert.match(all[0].note, /payment reversed/);

  const ws = await walletBalances(db);
  assert.equal(ws.find(w => w.kind === 'agency').balance, 40000, 'and the balance unwinds');
});

test('settling without a wallet still pays, it just records no source', async () => {
  // Bookkeeping must never be able to block a payout that has to happen.
  const db = seed();
  const r = await settlePayment(db, {
    clipperId: 1, submissionIds: [101], amount: 8000, campaignId: 7
  });
  assert.equal(r.ok, true);
  assert.equal(db._rows('submissions')[0].lock_reason, 'paid');
  assert.equal((await listEntries(db, {})).filter(r2 => r2.category === 'clipper_payout').length, 0);
});

test('a clip locked mid-flight rolls back the ledger entry too, not just the payment', async () => {
  // Guards the fix to the "best-effort" ledger write: it used to be its own
  // separate step, un-coordinated with the submission locks -- a race here
  // left the ledger entry sitting there, recording money for a payout the
  // conflict check had just refused. It's now in the same batch, and its
  // own undo path when that batch's row-count doesn't add up.
  const db = seed();
  const agency = (await walletOfKind(db, 'agency')).id;
  await addEntry(db, { direction: 'in', amount: 40000, wallet_id: agency,
                       category: 'client_payment', campaign_id: 7 });

  // A real concurrent payment row, so the racing UPDATE's payment_id
  // satisfies the same foreign key a genuine one would.
  const otherPaymentId = (await db.prepare(
    `INSERT INTO payments (clipper_id, campaign_id, amount, paid_at, created_at, kind)
     VALUES (1, 7, 8000, ?, ?, 'settlement')`
  ).bind(Date.now(), Date.now()).run()).meta.last_row_id;

  // Simulate a concurrent settle winning the race: the row reads as
  // unlocked during validation, then gets locked before our own UPDATE lands.
  const realPrepare = db.prepare.bind(db);
  let armed = true;
  db.prepare = (sql) => {
    if (armed && /^UPDATE submissions SET locked_at = \?, locked_earning = \?/.test(sql)) {
      armed = false;
      realPrepare(
        `UPDATE submissions SET locked_at = ?, locked_earning = ?, lock_reason = 'paid', payment_id = ? WHERE id = ?`
      ).bind(Date.now(), 8000, otherPaymentId, 101).run();
    }
    return realPrepare(sql);
  };

  const r = await settlePayment(db, {
    clipperId: 1, submissionIds: [101], amount: 8000, campaignId: 7, walletId: agency
  });

  assert.equal(r.status, 409, 'must report the conflict rather than returning ok');
  assert.equal((await listEntries(db, {})).filter(e => e.category === 'clipper_payout').length, 0,
    'the ledger entry from the rolled-back attempt must not survive either');
  const ws = await walletBalances(db);
  assert.equal(ws.find(w => w.kind === 'agency').balance, 40000, 'nothing left the wallet for a payout that never actually happened');
});

test('settling a clip with a real margin gap writes both entries in one batch, linked to the same payment', async () => {
  // 8,000 views billed at cpm 40 = 8,000... this test wants an actual gap,
  // so seed a clip whose billable amount does NOT land on a clean multiple.
  const db = seed();
  await db.prepare('UPDATE submissions SET earning = 8020, clipper_earning = 8000 WHERE id = 101').run();
  const agency = (await walletOfKind(db, 'agency')).id;
  await addEntry(db, { direction: 'in', amount: 40000, wallet_id: agency,
                       category: 'client_payment', campaign_id: 7 });

  const r = await settlePayment(db, {
    clipperId: 1, submissionIds: [101], amount: 8000, campaignId: 7, walletId: agency
  });
  assert.equal(r.ok, true);

  const payout = (await listEntries(db, {})).filter(e => e.category === 'clipper_payout');
  const margin = (await listEntries(db, {})).filter(e => e.category === 'view_margin');
  assert.equal(payout.length, 1);
  assert.equal(margin.length, 1);
  assert.equal(margin[0].amount, 20, 'the exact 8020 - 8000 gap');
  assert.equal(margin[0].payment_id, payout[0].payment_id, 'linked to the same settlement');
  assert.equal(margin[0].wallet_id, agency, 'lands in the same wallet clipper payouts draw from, not a third one');

  const ws = await walletBalances(db);
  // 40000 funded, -8000 payout, +20 margin realized.
  assert.equal(ws.find(w => w.kind === 'agency').balance, 40000 - 8000 + 20);
});

test('reversing a settlement voids the margin entry too, not just the clipper_payout one', async () => {
  const db = seed();
  await db.prepare('UPDATE submissions SET earning = 8020, clipper_earning = 8000 WHERE id = 101').run();
  const agency = (await walletOfKind(db, 'agency')).id;
  await addEntry(db, { direction: 'in', amount: 40000, wallet_id: agency,
                       category: 'client_payment', campaign_id: 7 });
  await settlePayment(db, {
    clipperId: 1, submissionIds: [101], amount: 8000, campaignId: 7, walletId: agency
  });

  const paymentId = db._rows('payments')[0].id;
  await reversePayment(db, paymentId);

  const liveMargin = (await listEntries(db, {})).filter(e => e.category === 'view_margin');
  assert.equal(liveMargin.length, 0, 'no longer counted');
  const allMargin = (await listEntries(db, { includeVoid: true })).filter(e => e.category === 'view_margin');
  assert.equal(allMargin.length, 1, 'but still on the record, voided');

  const ws = await walletBalances(db);
  assert.equal(ws.find(w => w.kind === 'agency').balance, 40000, 'fully unwound, including the margin');
});

test('the payout does not become an agency cost', async () => {
  // The client's money passes through to clippers. Counting it as our cost
  // would make every delivered campaign look like a loss.
  const db = seed();
  const agency = (await walletOfKind(db, 'agency')).id;
  // Fund the wallet first: you cannot pay out of an empty account.
  await addEntry(db, { direction: 'in', amount: 40000, wallet_id: agency,
                       category: 'client_payment', campaign_id: 7 });
  await settlePayment(db, {
    clipperId: 1, submissionIds: [101], amount: 8000, campaignId: 7, walletId: agency
  });

  const pnl = await agencyPnL(db);
  assert.equal(pnl.costs, 0, 'a client campaign payout is pass-through, not cost');
  assert.equal(pnl.fees_earned, 1600, '20% of the 8,000 delivered');
  assert.equal(pnl.agency_balance, 32000);
  assert.equal(pnl.view_margin_captured, 0, 'no margin gap on this fixture');
});

test('agencyPnL reports view_margin_captured, and it is never counted as profit', async () => {
  const db = seed();
  await db.prepare('UPDATE submissions SET earning = 8020, clipper_earning = 8000 WHERE id = 101').run();
  const agency = (await walletOfKind(db, 'agency')).id;
  await addEntry(db, { direction: 'in', amount: 40000, wallet_id: agency,
                       category: 'client_payment', campaign_id: 7 });
  await settlePayment(db, {
    clipperId: 1, submissionIds: [101], amount: 8000, campaignId: 7, walletId: agency
  });

  const pnl = await agencyPnL(db);
  assert.equal(pnl.view_margin_captured, 20);
  // profit = fees_earned - costs, unaffected by margin -- it is explicitly
  // not profit, just held in reserve.
  assert.equal(pnl.profit, pnl.fees_earned - pnl.costs);
});
