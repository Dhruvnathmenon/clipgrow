// The admin + moderator clipper rosters were computing ~6 queries PER clipper
// in a sequential loop -- the biggest slice of that page's load time and, past
// a few dozen clippers, enough to trip D1's per-request statement ceiling
// (the intermittent "internal error" on /api/(admin|moderator)/clippers).
//
// allClipperFinancials() and allClipperQuality() replace the loop with a
// fixed handful of grouped scans. These tests pin their output to be
// byte-identical to the per-clipper functions they replace, across every
// state that matters -- paid, advanced, bonus, disqualified, locked, reviewed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { clipperFinancials, allClipperFinancials, EMPTY_FINANCIALS } from '../src/db.js';
import { clipperQuality, allClipperQuality, EMPTY_QUALITY } from '../src/reviews.js';

const NOW = Date.now();

const clipper = (id) => ({ id, username: 'c' + id, password_hash: 'h', password_salt: 's',
                           status: 'active', created_at: NOW });
const clip = (id, clipperId, earning, o = {}) => ({
  id, clipper_id: clipperId, campaign_id: 1, platform: 'instagram', ig_media_id: 'm' + id,
  permalink: 'https://x/' + id, views: earning * 10, earning, clipper_earning: earning,
  status: 'active', created_at: NOW, ...o
});
const payment = (id, clipperId, kind, amount, o = {}) => ({
  id, clipper_id: clipperId, amount, kind, paid_at: NOW, created_at: NOW, recovered_amount: 0, ...o
});
const review = (id, submissionId, verdict) => ({
  id, submission_id: submissionId, verdict, reviewer_type: 'admin', reviewer_name: 'Admin', reviewed_at: NOW
});

function seed() {
  return makeSqliteD1({
    clippers: [clipper(1), clipper(2), clipper(3), clipper(4)],
    campaigns: [{ id: 1, name: 'C', cpm: 40, budget: 1000000, status: 'active',
                  created_at: NOW, min_views: 1000, allowed_platforms: 'instagram' }],
    // Before submissions -- submissions.payment_id has an FK onto payments.
    payments: [
      payment(1, 1, 'settlement', 3000),
      payment(2, 2, 'advance', 2000),
      payment(3, 3, 'bonus', 750)
    ],
    submissions: [
      // #1: one active, one locked/paid, one disqualified
      clip(10, 1, 4000),
      clip(11, 1, 3000, { locked_at: NOW, locked_earning: 3000, lock_reason: 'paid', payment_id: 1 }),
      clip(12, 1, 2000, { status: 'disqualified' }),
      // #2: two active, an advance against them
      clip(20, 2, 8000),
      clip(21, 2, 1200),
      // #3: one active, a bonus paid
      clip(30, 3, 5000)
      // #4: no clips at all
    ],
    submission_reviews: [
      review(1, 10, 'tick'), review(2, 11, 'tick'), review(3, 12, 'cross'),
      review(4, 20, 'tick'), review(5, 21, 'skip')
      // #3, #4: no reviews
    ]
  });
}

test('allClipperFinancials matches clipperFinancials for every clipper', async () => {
  const db = seed();
  const batch = await allClipperFinancials(db);
  for (const id of [1, 2, 3]) {
    const one = await clipperFinancials(db, id);
    assert.deepEqual(batch.get(id), one, `clipper ${id}`);
  }
  // #4 has nothing -- absent from the batch map, callers use EMPTY_FINANCIALS.
  assert.equal(batch.has(4), false);
  assert.deepEqual(await clipperFinancials(db, 4), EMPTY_FINANCIALS);
});

test('allClipperQuality matches clipperQuality for every clipper', async () => {
  const db = seed();
  const batch = await allClipperQuality(db);
  for (const id of [1, 2]) {
    assert.deepEqual(batch.get(id), await clipperQuality(db, id), `clipper ${id}`);
  }
  assert.equal(batch.has(3), false, 'no reviews -> absent');
  assert.deepEqual(await clipperQuality(db, 3), EMPTY_QUALITY);
  assert.deepEqual(EMPTY_QUALITY, { tick: 0, cross: 0, skip: 0, quality_pct: null });
});

test('the roster endpoint returns the same numbers the loop would have', async () => {
  const { handleAdmin } = await import('../src/routes/admin.js');
  const { createSessionCookie } = await import('../src/auth.js');
  const env = { DB: seed(), SESSION_SECRET: 's', ADMIN_PASSWORD: 'x' };
  const cookie = await createSessionCookie('admin', 'admin', 's');
  const req = new Request('https://clipgrow.in/api/admin/clippers', { headers: { Cookie: cookie.split(';')[0] } });
  const res = await handleAdmin(req, env, new URL(req.url));
  assert.equal(res.status, 200);
  const { clippers } = await res.json();

  const c1 = clippers.find(c => c.id === 1);
  assert.equal(c1.money.settled, 3000);
  assert.equal(c1.money.paid, 3000);
  assert.equal(c1.money.owed, 4000, 'active 4000; disqualified 2000 earns nothing; locked 3000 already paid');
  assert.equal(c1.quality.tick, 2);
  assert.equal(c1.quality.cross, 1);

  const c2 = clippers.find(c => c.id === 2);
  assert.equal(c2.money.pending, 9200);
  assert.equal(c2.money.owed, 7200, '9200 pending - 2000 advance');

  const c4 = clippers.find(c => c.id === 4);
  assert.deepEqual(c4.money, EMPTY_FINANCIALS);
  assert.deepEqual(c4.quality, EMPTY_QUALITY);
});
