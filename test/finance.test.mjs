// Agency finances.
//
// Two pots, on purpose:
//   agency    the working account. The clipper share of every client payment
//             lands here; payouts and costs leave from here. Empty means
//             clippers cannot be paid.
//   clipgrow  ClipGrow's own earned money -- the management-fee share.
//
// The founder's own money is deliberately NOT a pot. Fronting a client's
// delivery makes you their bank: financing risk for no financing return, and
// the way a profitable agency runs out of cash. Removing that option does not
// remove the risk though -- it relocates it onto the clippers -- so the
// collection guard below is what actually has to do the work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import {
  walletBalances, walletOfKind, recordClientPayment, founderOwed, agencyAvailable,
  poolHeld, campaignFinancials, campaignFunding, fundingAlerts, agencyPnL,
  addEntry, voidEntry, listEntries, validateEntry
} from '../src/finance.js';

const NOW = Date.now();

/** budget = the CLIPPER POOL. The 20% fee sits on top of it. */
function seed({ budget = 100000, feePercent = 20, kind = 'client', clips = [] } = {}) {
  return makeSqliteD1({
    clients: [{ id: 1, username: 'heyschool', password_hash: 'h', password_salt: 's',
                company_name: 'heyschool', status: 'active', created_at: NOW }],
    clippers: [{ id: 1, username: 'ravi', display_name: 'Ravi',
                 password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }],
    campaigns: [{ id: 7, name: 'Acme', cpm: 40, budget, status: 'active', created_at: NOW,
                  min_views: 1000, allowed_platforms: 'instagram',
                  campaign_kind: kind, fee_percent: feePercent }],
    submissions: clips.map((c, i) => ({
      id: 100 + i, clipper_id: 1, campaign_id: 7, platform: 'instagram',
      ig_media_id: 'm' + i, permalink: 'p' + i, views: 10000,
      earning: c.earning, status: 'active', created_at: NOW,
      locked_at: c.locked ? NOW : null,
      locked_earning: c.locked ? c.earning : null,
      lock_reason: c.locked ? 'paid' : null
    }))
  });
}

// Wallets are found by kind, so a rename can never break a money test.
async function ids(db) {
  return {
    agency: (await walletOfKind(db, 'agency')).id,
    clipgrow: (await walletOfKind(db, 'clipgrow')).id
  };
}
const bal = (ws, kind) => ws.find(w => w.kind === kind).balance;

/* ─────────── a client payment splits the moment it arrives ─────────── */

test('a client payment splits into clipper money and our fee', async () => {
  const db = seed();
  const r = await recordClientPayment(db, { clientId: 1, campaignId: 7, amount: 48000, feePercent: 20 });

  // 120% commitment: 20/120 of anything received is fee, 100/120 clipper money.
  assert.equal(r.fee, 8000);
  assert.equal(r.pool_share, 40000);

  const ws = await walletBalances(db);
  assert.equal(bal(ws, 'agency'), 40000, 'clipper money, in the working account');
  assert.equal(bal(ws, 'clipgrow'), 8000, 'the fee, and only the fee, is ours');
});

test('the split never loses or invents a rupee', async () => {
  const db = seed();
  const r = await recordClientPayment(db, { clientId: 1, campaignId: 7, amount: 20000, feePercent: 20 });
  assert.equal(r.fee + r.pool_share, 20000);
  assert.equal(r.fee, 3333);
  assert.equal(r.pool_share, 16667);
});

/* ─────────── you cannot pay what you do not hold ─────────── */

test('the agency balance is what is actually available to pay clippers', async () => {
  const db = seed();
  assert.equal(await agencyAvailable(db), 0, 'nothing in, nothing to pay with');

  await recordClientPayment(db, { clientId: 1, campaignId: 7, amount: 48000, feePercent: 20 });
  assert.equal(await agencyAvailable(db), 40000,
    'the fee sits in the other wallet and does not inflate this');
});

test('paying a clipper draws the agency wallet down', async () => {
  const db = seed();
  const W = await ids(db);
  await recordClientPayment(db, { clientId: 1, campaignId: 7, amount: 48000, feePercent: 20 });
  await addEntry(db, { direction: 'out', amount: 30000, wallet_id: W.agency,
                       category: 'clipper_payout', campaign_id: 7, clipper_id: 1,
                       note: 'Weekly run' });

  assert.equal(await agencyAvailable(db), 10000);
  assert.equal(await poolHeld(db, { campaignId: 7 }), 10000,
    'clipper money received but not yet paid out');
});

/* ─────────── delivering faster than we collect ─────────── */

test('the funding guard warns at 70% used, not when the money is gone', async () => {
  // Collection takes days and clippers post daily, so "you are empty" is far
  // too late to start asking for the next tranche.
  const db = seed({ clips: [{ earning: 29000 }] });
  await recordClientPayment(db, { clientId: 1, campaignId: 7, amount: 48000, feePercent: 20 });

  const f = await campaignFunding(db, 7);
  assert.equal(f.collected, 40000, 'the clipper share of what arrived');
  assert.equal(f.delivered, 29000);
  assert.equal(f.headroom, 11000);
  assert.ok(f.used_ratio > 0.7);
  assert.equal(f.should_invoice, true, 'ask for the next tranche now');
  assert.equal(f.critical, false);
});

test('below the threshold nothing is raised', async () => {
  const db = seed({ clips: [{ earning: 10000 }] });
  await recordClientPayment(db, { clientId: 1, campaignId: 7, amount: 48000, feePercent: 20 });

  assert.equal((await campaignFunding(db, 7)).should_invoice, false);
  assert.equal((await fundingAlerts(db)).length, 0);
});

test('delivering beyond what a client has paid is flagged as unfunded', async () => {
  // With no founder money to fall back on, this is the number that decides
  // whether Sunday's payout run can happen at all.
  const db = seed({ clips: [{ earning: 50000 }] });
  await recordClientPayment(db, { clientId: 1, campaignId: 7, amount: 48000, feePercent: 20 });

  const f = await campaignFunding(db, 7);
  assert.equal(f.unfunded, 10000, 'clippers earned 10,000 no client money covers');
  assert.equal(f.critical, true);
  assert.equal((await fundingAlerts(db)).length, 1);
  assert.equal((await agencyPnL(db)).unfunded_delivery, 10000);
});

test('a campaign with no client money at all is immediately critical', async () => {
  const db = seed({ clips: [{ earning: 5000 }] });
  const f = await campaignFunding(db, 7);
  assert.equal(f.collected, 0);
  assert.equal(f.unfunded, 5000);
  assert.equal(f.critical, true);
});

test('an internal campaign is never a funding alert', async () => {
  // We fund our own marketing by definition; there is no client to chase.
  const db = seed({ kind: 'internal', clips: [{ earning: 8000 }] });
  assert.equal(await campaignFunding(db, 7), null);
  assert.equal((await fundingAlerts(db)).length, 0);
});

test('founder money stays at zero now the agency funds itself', async () => {
  const db = seed();
  await recordClientPayment(db, { clientId: 1, campaignId: 7, amount: 48000, feePercent: 20 });
  assert.equal(await founderOwed(db), 0,
    'if this ever rises, the no-personal-money rule has slipped');
});

/* ─────────── stopping a campaign ─────────── */

test('stopping early: the refund is unspent clipper money plus unearned fee', async () => {
  const db = seed({ clips: [{ earning: 30000 }] });
  const W = await ids(db);

  await recordClientPayment(db, { clientId: 1, campaignId: 7, amount: 48000, feePercent: 20 });
  await addEntry(db, { direction: 'out', amount: 30000, wallet_id: W.agency,
                       category: 'clipper_payout', campaign_id: 7, clipper_id: 1 });

  const fin = await campaignFinancials(db, 7);
  assert.equal(fin.delivered, 30000);
  assert.equal(fin.fee_earned, 6000, '20% of what was actually delivered');
  assert.equal(fin.fee_taken, 8000, 'but 8,000 was taken when they paid');
  assert.equal(fin.unearned_fee, 2000, 'so 2,000 comes back out of our wallet');
  assert.equal(fin.unspent_pool, 10000);
  assert.equal(fin.refund_due, 12000, 'unspent clipper money + unearned fee');

  // The same figure the website promises, reached a different way.
  assert.equal(fin.refund_due, 48000 - 30000 - 6000);
});

test('a refund actually recorded reduces what the campaign still shows as owed', async () => {
  const db = seed({ clips: [{ earning: 30000 }] });
  const W = await ids(db);

  await recordClientPayment(db, { clientId: 1, campaignId: 7, amount: 48000, feePercent: 20 });
  await addEntry(db, { direction: 'out', amount: 30000, wallet_id: W.agency,
                       category: 'clipper_payout', campaign_id: 7, clipper_id: 1 });

  const before = await campaignFinancials(db, 7);
  assert.equal(before.unspent_pool, 10000);
  assert.equal(before.unearned_fee, 2000);
  assert.equal(before.refund_due, 12000);

  // Refund the whole unspent pool -- recorded against the agency wallet,
  // same as the money it's returning actually sat in.
  await addEntry(db, { direction: 'out', amount: 10000, wallet_id: W.agency,
                       category: 'refund', campaign_id: 7 });

  const after = await campaignFinancials(db, 7);
  assert.equal(after.unspent_pool, 0, 'already refunded -- must not still show as owed');
  assert.equal(after.budget_balance, 0);
  assert.equal(after.unearned_fee, 2000, 'the fee side is untouched by a budget-side refund');
  assert.equal(after.refund_due, 2000, 'only the fee refund is left to give back');
});

test('a fee refund and a budget refund are tracked independently, by wallet', async () => {
  const db = seed({ clips: [{ earning: 30000 }] });
  const W = await ids(db);
  await recordClientPayment(db, { clientId: 1, campaignId: 7, amount: 48000, feePercent: 20 });
  await addEntry(db, { direction: 'out', amount: 30000, wallet_id: W.agency,
                       category: 'clipper_payout', campaign_id: 7, clipper_id: 1 });

  // Refund only the unearned fee -- out of the clipgrow wallet, not the pool.
  await addEntry(db, { direction: 'out', amount: 2000, wallet_id: W.clipgrow,
                       category: 'refund', campaign_id: 7 });

  const fin = await campaignFinancials(db, 7);
  assert.equal(fin.unearned_fee, 0, 'the fee refund is already accounted for');
  assert.equal(fin.fee_balance, 0);
  assert.equal(fin.unspent_pool, 10000, 'the budget pool refund is untouched by a fee-side refund');
  assert.equal(fin.refund_due, 10000);
});

test('budget_balance and fee_balance go negative once a refund overshoots into a real shortfall', async () => {
  const db = seed({ clips: [{ earning: 30000 }] });
  const W = await ids(db);
  await recordClientPayment(db, { clientId: 1, campaignId: 7, amount: 48000, feePercent: 20 });
  await addEntry(db, { direction: 'out', amount: 30000, wallet_id: W.agency,
                       category: 'clipper_payout', campaign_id: 7, clipper_id: 1 });

  // Refund more of the pool than is actually unspent (e.g. a goodwill
  // refund) -- the client now genuinely owes for delivered work.
  await addEntry(db, { direction: 'out', amount: 15000, wallet_id: W.agency,
                       category: 'refund', campaign_id: 7 });

  const fin = await campaignFinancials(db, 7);
  assert.equal(fin.budget_balance, -5000, 'signed: negative means the client now owes this much');
  assert.equal(fin.unspent_pool, 0, 'the floored, refund-owed-only version never goes negative');
});

test('a client behind on payment leaves a shortfall, not a refund', async () => {
  const db = seed({ clips: [{ earning: 30000 }] });
  await recordClientPayment(db, { clientId: 1, campaignId: 7, amount: 20000, feePercent: 20 });

  const fin = await campaignFinancials(db, 7);
  assert.equal(fin.client_obligation, 36000, 'delivered + fee on delivered');
  assert.equal(fin.client_paid, 20000);
  assert.equal(fin.shortfall, 16000, 'collect this before terminating');
  assert.equal(fin.refund_due, 0);
});

/* ─────────── internal campaigns ─────────── */

test('an internal campaign earns no fee and its payouts are a real cost', async () => {
  const db = seed({ kind: 'internal', clips: [{ earning: 8000 }] });
  const W = await ids(db);
  await addEntry(db, { direction: 'out', amount: 8000, wallet_id: W.agency,
                       category: 'clipper_payout', campaign_id: 7, clipper_id: 1 });

  const fin = await campaignFinancials(db, 7);
  assert.equal(fin.fee_earned, 0, 'nobody bills us for our own marketing');
  assert.equal(fin.cost, 8000);
  assert.equal((await agencyPnL(db)).profit, -8000, 'our own campaign costs us money');
});

/* ─────────── profit and cash are allowed to disagree ─────────── */

test('a profitable position can sit alongside an empty account', async () => {
  // Work delivered, client has not paid, and no founder money to paper over it
  // -- so clippers are owed money that does not exist yet. Sandy's blind spot.
  const db = seed({ clips: [{ earning: 30000 }] });

  const pnl = await agencyPnL(db);
  assert.equal(pnl.fees_earned, 6000, 'earned by delivering');
  assert.equal(pnl.fees_collected, 0, 'but not a rupee collected');
  assert.ok(pnl.profit > 0, 'profitable on paper');
  assert.equal(pnl.clipgrow_balance, 0, 'and nothing in our own wallet');
  assert.equal(pnl.unfunded_delivery, 30000, 'while 30,000 of delivery is unfunded');
  assert.equal(pnl.receivable, 36000, 'the client owes delivered + fee');
});

/* ─────────── writing rules ─────────── */

test('a negative amount is refused — direction carries the sign', () => {
  assert.match(validateEntry({ direction: 'out', category: 'tool', amount: -50, wallet_id: 1 }), /positive number/);
  assert.match(validateEntry({ direction: 'sideways', category: 'tool', amount: 50, wallet_id: 1 }), /not a valid direction/);
  assert.match(validateEntry({ direction: 'out', category: 'nonsense', amount: 50, wallet_id: 1 }), /not a valid category/);
  assert.match(validateEntry({ direction: 'out', category: 'tool', amount: 50 }), /Pick which wallet/);
});

test('an entry is voided, never deleted, and stops counting immediately', async () => {
  const db = seed();
  const W = await ids(db);
  const { id } = await addEntry(db, { direction: 'out', amount: 900, wallet_id: W.agency,
                                      category: 'tool', note: 'Editing software' });
  assert.equal((await agencyPnL(db)).costs, 900);

  assert.equal((await voidEntry(db, id, 'entered twice')).ok, true);
  assert.equal((await agencyPnL(db)).costs, 0, 'no longer counted');

  const rows = await listEntries(db, { includeVoid: true });
  assert.equal(rows.length, 1, 'but the row is still there');
  assert.match(rows[0].note, /voided: entered twice/, 'with the reason attached');
  assert.equal((await voidEntry(db, id, 'again')).status, 409, 'and cannot be voided twice');
});

test('the ledger reads back with every link resolved', async () => {
  const db = seed();
  await recordClientPayment(db, { clientId: 1, campaignId: 7, amount: 48000, feePercent: 20,
                                  reference: 'NEFT-8891', note: 'First tranche' });

  const rows = await listEntries(db, {});
  assert.equal(rows.length, 2, 'one row for the clipper share, one for the fee');
  for (const r of rows) {
    assert.equal(r.client_name, 'heyschool');
    assert.equal(r.campaign_name, 'Acme');
    assert.equal(r.reference, 'NEFT-8891');
    assert.match(r.note, /First tranche/, 'the why, kept on both halves');
  }
});

test('wallet balances reconcile with the raw entries', async () => {
  const db = seed();
  const W = await ids(db);
  await recordClientPayment(db, { clientId: 1, campaignId: 7, amount: 48000, feePercent: 20 });
  await addEntry(db, { direction: 'out', amount: 900, wallet_id: W.agency, category: 'tool' });

  const total = (await walletBalances(db)).reduce((n, w) => n + w.balance, 0);
  const expected = (await listEntries(db, {}))
    .reduce((n, r) => n + (r.direction === 'in' ? r.amount : -r.amount), 0);
  assert.equal(total, expected, 'wallets sum to the raw ledger');
});
