// The admin Overview's "Left to Pay" and the per-clipper "Owed" column on the
// roster directly beneath it were two independent formulas that provably
// disagreed -- and "Left to Pay" is the number used to decide how much money
// to send.
//
//   Overview:     max(0, SUM(earning WHERE active) - SUM(payments not bonus))
//   Per clipper:  max(0, pending - unrecovered advances)
//
// They diverged four ways: the Overview counted locked (already paid) clips as
// still owed, subtracted advances GROSS rather than unrecovered, summed raw
// `earning` instead of SPEND_EXPR, and -- worst -- floored ONCE globally, which
// nets one clipper's payments against another clipper's unpaid earnings.
//
// clipperFinancials() had no test importing it at all, so none of this was
// guarded. totalOutstanding() is now the sum of the same per-clipper rule, and
// these tests pin the two together.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { clipperFinancials, totalOutstanding } from '../src/db.js';

const NOW = Date.now();

const clipper = (id, o = {}) => ({
  id, username: 'c' + id, password_hash: 'h', password_salt: 's',
  status: 'active', created_at: NOW, ...o
});

const clip = (id, clipperId, earning, o = {}) => ({
  id, clipper_id: clipperId, campaign_id: 1, account_id: null, platform: 'instagram',
  ig_media_id: 'm' + id, permalink: 'p' + id, views: earning * 10, earning,
  status: 'active', created_at: NOW, ...o
});

const payment = (id, clipperId, kind, amount, o = {}) => ({
  id, clipper_id: clipperId, campaign_id: null, amount, kind,
  paid_at: NOW, created_at: NOW, recovered_amount: 0, ...o
});

function seed({ clippers, submissions = [], payments = [] }) {
  return makeSqliteD1({
    clippers,
    campaigns: [{ id: 1, name: 'C', cpm: 40, budget: 1000000, status: 'active',
                  created_at: NOW, min_views: 1000, allowed_platforms: 'instagram' }],
    submissions,
    payments
  });
}

/** The invariant: the headline figure is exactly the sum of the rows below it. */
async function assertAgrees(db, ids) {
  const each = [];
  for (const id of ids) each.push((await clipperFinancials(db, id)).owed);
  const sum = each.reduce((a, b) => a + b, 0);
  const total = await totalOutstanding(db);
  assert.equal(total, sum, `Left to Pay ${total} != sum of per-clipper owed ${sum} (${each.join(' + ')})`);
  return total;
}

test('one clipper is paid while another is owed: payments do not cross clippers', async () => {
  // The exact shape found on the live database. A settled payment to a clipper
  // who is owed nothing made the OLD global formula report Rs 5,000 less owed
  // to two entirely different people.
  const db = seed({
    clippers: [clipper(1), clipper(2), clipper(3)],
    submissions: [clip(10, 2, 8000), clip(11, 3, 5120)],
    payments: [payment(1, 1, 'settlement', 5000)]
  });

  const total = await assertAgrees(db, [1, 2, 3]);
  assert.equal(total, 13120, 'both unpaid clippers are still owed in full');

  // What the old rule produced, for the record.
  const old = Math.max(0, (8000 + 5120) - 5000);
  assert.equal(old, 8120);
  assert.notEqual(old, total, 'the old global formula understated this by Rs 5,000');
});

test('an advance nets off only against the clipper who received it', async () => {
  const db = seed({
    clippers: [clipper(1), clipper(2)],
    submissions: [clip(10, 1, 3000), clip(11, 2, 4000)],
    payments: [payment(1, 1, 'advance', 1000)]
  });

  const total = await assertAgrees(db, [1, 2]);
  assert.equal(total, 6000, '3000 - 1000 owed to #1, 4000 to #2');
});

test('an over-advanced clipper cannot drag another clipper below zero', async () => {
  // This is the per-clipper floor. Globally: max(0, 4000 - 9000) = 0, which
  // would claim nothing is owed to #2 at all.
  const db = seed({
    clippers: [clipper(1), clipper(2)],
    submissions: [clip(10, 1, 1000), clip(11, 2, 3000)],
    payments: [payment(1, 1, 'advance', 9000)]
  });

  const total = await assertAgrees(db, [1, 2]);
  assert.equal(total, 3000, '#2 is still owed 3000 despite #1 being 8000 over-advanced');
  assert.equal(Math.max(0, 4000 - 9000), 0, 'the global rule would have said zero');
});

test('a bonus never reduces what is owed', async () => {
  const db = seed({
    clippers: [clipper(1)],
    submissions: [clip(10, 1, 2000)],
    payments: [payment(1, 1, 'bonus', 750)]
  });

  const m = await clipperFinancials(db, 1);
  assert.equal(m.bonuses, 750);
  assert.equal(m.owed, 2000, 'a bonus is money on top, not an advance against work');
  assert.equal(await assertAgrees(db, [1]), 2000);
});

test('a recovered advance stops being deducted', async () => {
  const db = seed({
    clippers: [clipper(1)],
    submissions: [clip(10, 1, 2000)],
    payments: [payment(1, 1, 'advance', 500, { recovered_amount: 500 })]
  });

  const m = await clipperFinancials(db, 1);
  assert.equal(m.advanced, 0, 'advanced tracks the UNRECOVERED remainder');
  assert.equal(m.owed, 2000);
  assert.equal(await assertAgrees(db, [1]), 2000);
});

test('locked clips leave owed, and earned still counts them', async () => {
  const db = seed({
    clippers: [clipper(1)],
    submissions: [
      clip(10, 1, 2000),
      clip(11, 1, 1500, { locked_at: NOW, locked_earning: 1500, lock_reason: 'paid' })
    ],
    payments: [payment(1, 1, 'settlement', 1500)]
  });

  const m = await clipperFinancials(db, 1);
  assert.equal(m.pending, 2000);
  assert.equal(m.settled, 1500);
  assert.equal(m.earned, 3500, 'earned === settled + pending');
  assert.equal(m.owed, 2000, 'the paid clip is no longer owed');
  assert.equal(await assertAgrees(db, [1]), 2000);
});

test('a paid-then-disqualified clip keeps its settled money in earned', async () => {
  // SPEND_EXPR counts a locked clip whatever its status later becomes: that
  // money genuinely left the account. Summing raw `earning WHERE active`
  // silently dropped it from every total on the site.
  const db = seed({
    clippers: [clipper(1)],
    submissions: [
      clip(10, 1, 900, { status: 'disqualified', locked_at: NOW, locked_earning: 900, lock_reason: 'paid' })
    ],
    payments: [payment(1, 1, 'settlement', 900)]
  });

  const m = await clipperFinancials(db, 1);
  assert.equal(m.earned, 900, 'the money that was actually paid still counts');
  assert.equal(m.pending, 0);
  assert.equal(m.owed, 0);
});

test('no clippers at all is zero, not null', async () => {
  const db = seed({ clippers: [] });
  assert.equal(await totalOutstanding(db), 0);
});
