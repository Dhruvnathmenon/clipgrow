// A kicked clipper's earnings are meant to freeze at what they had accrued.
// The allocator used to read that figure from `earning` -- its own previous
// output -- which made repricing a one-way ratchet: a pass run while the budget
// was short wrote the value down, and restoring the budget never brought it
// back. frozen_earning is written once, at the moment of kicking, so repricing
// is idempotent.

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

test('a kicked clipper survives a budget cut and restore with their frozen figure intact', async () => {
  // Clip K is frozen at 3000. Earlier clips hold 7000 of the 10000 budget.
  const db = makePayoutsDb({
    campaigns: [campaign()],
    submissions: [
      sub({ id: 1, clipper_id: 2, created_at: 1, views: 70000, earning: 7000 }),
      sub({ id: 2, clipper_id: 1, created_at: 2, views: 30000, earning: 3000, frozen_earning: 3000 })
    ],
    participations: [
      { id: 1, clipper_id: 2, campaign_id: 1, status: 'active' },
      { id: 2, clipper_id: 1, campaign_id: 1, status: 'kicked' }
    ]
  });

  // Admin mistypes the budget as 8000. Only 1000 is left for the kicked clip.
  db._state.campaigns[0].budget = 8000;
  await reallocateCampaign(db, 1);
  assert.equal(earningOf(db, 2), 1000, 'payable now is clamped by the smaller budget');

  // Admin notices and restores the budget.
  db._state.campaigns[0].budget = 10000;
  await reallocateCampaign(db, 1);
  assert.equal(earningOf(db, 2), 3000, 'the frozen figure must come back in full');
});

test('repricing a kicked clipper repeatedly never erodes the frozen figure', async () => {
  const db = makePayoutsDb({
    campaigns: [campaign()],
    submissions: [sub({ id: 1, views: 30000, earning: 3000, frozen_earning: 3000 })],
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'kicked' }]
  });
  for (let i = 0; i < 5; i++) await reallocateCampaign(db, 1);
  assert.equal(earningOf(db, 1), 3000);
});

test('a kicked clip still consumes budget, so active clips cannot spend its money', async () => {
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
  assert.equal(earningOf(db, 1), 3000, 'kicked clipper keeps their frozen money');
  assert.equal(earningOf(db, 2), 2000, 'the active clip only gets what is genuinely left');
});

test('falls back to current earning when no frozen figure was recorded', async () => {
  // Participations kicked before this column existed have frozen_earning NULL.
  const db = makePayoutsDb({
    campaigns: [campaign()],
    submissions: [sub({ id: 1, views: 30000, earning: 3000, frozen_earning: null })],
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'kicked' }]
  });
  await reallocateCampaign(db, 1);
  assert.equal(earningOf(db, 1), 3000);
});
