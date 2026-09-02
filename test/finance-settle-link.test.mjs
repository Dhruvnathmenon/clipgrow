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
});
