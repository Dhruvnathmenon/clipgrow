// Kicking a clipper from a campaign RELEASES their unpaid earnings: those
// clips drop to zero and every rupee they were holding flows back into the
// campaign pool for everyone still clipping. A kick is a deliberate "we are
// done with this clipper" call -- most often for botting or off-guideline
// work -- so there is nothing to preserve. Already-settled (locked) clips are
// the one exception: their money is real, paid history and is never touched.
//
// frozen_earning is still stamped at kick time (src/routes/admin.js) as a
// record of what the clipper was worth in that moment, for a payout dispute --
// the allocator just no longer reads it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePayoutsDb } from './helpers/fake-payouts-db.mjs';
import { reallocateCampaign } from '../src/earnings.js';

function campaign(o = {}) {
  return { id: 1, name: 'C', cpm: 100, min_views: 1000, budget: 10000, blueprint_json: '{}', status: 'active', ...o };
}
function sub(o = {}) {
  const now = Date.now();
  return {
    id: 1, clipper_id: 1, campaign_id: 1, account_id: null,
    permalink: 'https://x/1', views: 30000, earning: 3000,
    status: 'active', sync_error: null, source: 'manual', platform: 'instagram',
    duration_seconds: null, is_short: null, eligible: 1,
    created_at: now, posted_at: now, last_synced_at: now, last_ok_sync_at: now,
    locked_at: null, locked_earning: null, lock_reason: null, payment_id: null,
    frozen_earning: null, ...o
  };
}
const earningOf = (db, id) => db._state.submissions.find(s => s.id === id).earning;

test('kicking a clipper zeroes their unpaid clips and frees the budget for active ones', async () => {
  const db = makePayoutsDb({
    campaigns: [campaign({ budget: 5000 })],
    submissions: [
      sub({ id: 1, clipper_id: 1, created_at: 1, views: 30000, earning: 3000, frozen_earning: 3000 }),
      sub({ id: 2, clipper_id: 2, created_at: 2, views: 40000, earning: 0 })
    ],
    participations: [
      { id: 1, clipper_id: 1, campaign_id: 1, status: 'kicked' },
      { id: 2, clipper_id: 2, campaign_id: 1, status: 'active' }
    ]
  });
  await reallocateCampaign(db, 1);
  assert.equal(earningOf(db, 1), 0, 'the kicked clipper earns nothing');
  assert.equal(earningOf(db, 2), 4000, 'the active clip gets the full budget the kicked one released');
});

test('a kicked clipper still holds nothing even when the budget is huge', async () => {
  const db = makePayoutsDb({
    campaigns: [campaign({ budget: 1000000 })],
    submissions: [sub({ id: 1, views: 30000, earning: 3000, frozen_earning: 3000 })],
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'kicked' }]
  });
  for (let i = 0; i < 3; i++) await reallocateCampaign(db, 1);
  assert.equal(earningOf(db, 1), 0, 'repricing never revives a kicked clipper');
});

test('a kicked clipper\'s already-PAID clip is untouched -- paid stays paid', async () => {
  const db = makePayoutsDb({
    campaigns: [campaign({ budget: 10000 })],
    submissions: [
      // Locked/paid clip from the now-kicked clipper.
      sub({ id: 1, clipper_id: 1, created_at: 1, views: 30000, earning: 3000,
            locked_at: 123, locked_earning: 3000, lock_reason: 'paid', payment_id: 9 }),
      // Their other, unpaid clip.
      sub({ id: 2, clipper_id: 1, created_at: 2, views: 20000, earning: 2000, frozen_earning: 2000 }),
      // An active clipper competing for what is left.
      sub({ id: 3, clipper_id: 2, created_at: 3, views: 90000, earning: 0 })
    ],
    participations: [
      { id: 1, clipper_id: 1, campaign_id: 1, status: 'kicked' },
      { id: 2, clipper_id: 2, campaign_id: 1, status: 'active' }
    ]
  });
  await reallocateCampaign(db, 1);
  assert.equal(earningOf(db, 1), 3000, 'the paid clip keeps its locked earning');
  assert.equal(earningOf(db, 2), 0, 'the unpaid clip is released');
  assert.equal(earningOf(db, 3), 7000, 'the active clip gets everything except the 3000 already paid out');
});

test('reinstating a kicked clipper puts their clips back on normal pricing', async () => {
  const db = makePayoutsDb({
    campaigns: [campaign({ budget: 10000 })],
    submissions: [sub({ id: 1, views: 30000, earning: 0, frozen_earning: 3000 })],
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'kicked' }]
  });
  await reallocateCampaign(db, 1);
  assert.equal(earningOf(db, 1), 0, 'nothing while kicked');

  db._state.participations[0].status = 'active';
  await reallocateCampaign(db, 1);
  assert.equal(earningOf(db, 1), 3000, 'back to the real CPM value once reinstated');
});
