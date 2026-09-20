import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { allocateCampaignEarnings } from '../src/earnings.js';
import { payableClips, settlePayment } from '../src/payouts.js';
import { walletOfKind } from '../src/finance.js';

const NOW = Date.now();

// D1 refuses a statement with more than 100 bound parameters. A payout over that
// many clips used to build one IN (...) with a parameter per clip, so the admin
// pressed "Pay & Lock" and got "Internal server error" -- while every test passed,
// because the test database has no such limit. (The test database now enforces it.)
test('a payout covering hundreds of clips settles and locks every one', async () => {
  const N = 250;
  const subs = Array.from({ length: N }, (_, i) => ({
    id: i + 1, clipper_id: 1, campaign_id: 1, platform: 'instagram',
    ig_media_id: `m${i}`, permalink: `p${i}`, views: 2000, earning: 0,
    status: 'active', eligible: 1, created_at: NOW - i, posted_at: NOW - i
  }));
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'c1', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'T', cpm: 50, budget: 10000000, status: 'active', created_at: NOW,
                  min_views: 1000, allowed_platforms: 'instagram', campaign_kind: 'client', fee_percent: 20 }],
    submissions: subs
  });
  await allocateCampaignEarnings(db, 1);

  const { totals } = await payableClips(db, 1, { days: 0 });
  assert.equal(totals.payable_clips, N);

  const agency = (await walletOfKind(db, 'agency')).id;
  const r = await settlePayment(db, {
    clipperId: 1, submissionIds: subs.map(s => s.id), amount: totals.payable_now,
    expectedClipsTotal: totals.payable_now, campaignId: 1, walletId: agency,
    allowBelowMinimum: true, allowUnfunded: true
  });
  assert.equal(r.error, undefined, r.error);
  const locked = db._sqlite.prepare('SELECT COUNT(*) n FROM submissions WHERE locked_at IS NOT NULL').get().n;
  assert.equal(locked, N, 'every clip in the payout is locked against it');
});

test('the test database enforces D1\'s bound-parameter limit', () => {
  const db = makeSqliteD1({});
  assert.throws(() => db.prepare('SELECT 1').bind(...new Array(101).fill(1)), /too many SQL variables/);
});
