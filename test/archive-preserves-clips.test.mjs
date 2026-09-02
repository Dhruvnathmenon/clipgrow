// Archiving a clipper permanently deleted every one of their UNPAID clips,
// while the confirm dialog promised "every video and payment stays on record …
// You can restore them". A clipper who had earned but not yet been paid lost
// 100% of their history and their earnings, with no undo and no audit trail;
// Restore brought back an empty shell.
//
// The archive path (DELETE /api/admin/clippers/:id) loops every social account
// into disconnectSocialAccount, which ran `DELETE FROM submissions` for every
// row with locked_at IS NULL. Archiving now passes preserveClips, so nothing
// is deleted; only the explicit single-account disconnect still destroys, and
// its dialog states the count and rupee value first.
//
// Runs against real SQLite so the foreign keys are genuinely enforced -- the
// account row has to survive too, or the clips it is referenced by cannot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { disconnectSocialAccount } from '../src/db.js';

const NOW = Date.now();

/** A clipper with one paid clip and two unpaid ones worth Rs 900 together. */
function seed() {
  return makeSqliteD1({
    clippers: [{ id: 5, username: 'c', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }],
    campaigns: [{ id: 3, name: 'C', cpm: 40, budget: 100000, status: 'active',
                  created_at: NOW, min_views: 1000, allowed_platforms: 'instagram' }],
    social_accounts: [{ id: 5, clipper_id: 5, platform: 'instagram', external_id: 'ig5',
                        username: 'handle', account_type: 'BUSINESS', access_token: 't',
                        refresh_token: 'r', status: 'connected', connected_at: NOW, auto_import: 1 }],
    participations: [{ id: 6, clipper_id: 5, campaign_id: 3, status: 'active', joined_at: NOW, account_id: 5 }],
    participation_accounts: [{ id: 60, participation_id: 6, account_id: 5, platform: 'instagram', linked_at: NOW }],
    submissions: [
      { id: 900, clipper_id: 5, campaign_id: 3, account_id: 5, platform: 'instagram',
        ig_media_id: 'm900', permalink: 'p900', views: 5000, earning: 200, status: 'active',
        created_at: NOW, locked_at: NOW, locked_earning: 200, lock_reason: 'paid' },
      { id: 901, clipper_id: 5, campaign_id: 3, account_id: 5, platform: 'instagram',
        ig_media_id: 'm901', permalink: 'p901', views: 15000, earning: 600, status: 'active',
        created_at: NOW },
      { id: 902, clipper_id: 5, campaign_id: 3, account_id: 5, platform: 'instagram',
        ig_media_id: 'm902', permalink: 'p902', views: 7500, earning: 300, status: 'active',
        created_at: NOW }
    ],
    ig_api_calls: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, social_account_id: 5, called_at: NOW }))
  });
}

test('archiving a clipper preserves every clip and every earning', async () => {
  const db = seed();

  const r = await disconnectSocialAccount(db, 5, { preserveClips: true });

  assert.equal(r.deleted_pending, 0, 'nothing is deleted');
  assert.equal(r.preserved_pending, 2, 'both unpaid clips are reported as kept');

  const subs = db._rows('submissions').sort((a, b) => a.id - b.id);
  assert.equal(subs.length, 3, 'all three clips survive');
  assert.deepEqual(subs.map(s => s.id), [900, 901, 902]);

  // The money is the point: earned-but-unpaid value must be intact.
  assert.equal(subs.find(s => s.id === 901).earning, 600);
  assert.equal(subs.find(s => s.id === 902).earning, 300);
  assert.equal(subs.find(s => s.id === 900).locked_earning, 200, 'paid history untouched');
});

test('archiving keeps the account row so the preserved clips still resolve', async () => {
  const db = seed();

  await disconnectSocialAccount(db, 5, { preserveClips: true });

  const accounts = db._rows('social_accounts');
  assert.equal(accounts.length, 1, 'the row stays -- submissions.account_id points at it');
  assert.equal(accounts[0].status, 'revoked');
  assert.equal(accounts[0].access_token, null, 'but it can no longer call the platform');
  assert.equal(accounts[0].refresh_token, null);
});

test('archiving still releases the campaign link, so a new account can take over', async () => {
  const db = seed();

  await disconnectSocialAccount(db, 5, { preserveClips: true });

  assert.equal(db._rows('participation_accounts').length, 0, 'the canonical link is released');
  assert.equal(db._rows('participations')[0].account_id, null, 'and the legacy column too');
});

test('an explicit single-account disconnect still deletes unpaid clips', async () => {
  // The destructive path is deliberately kept -- it is the legitimate cleanup
  // for a wrongly-connected account. What changed is that it is now the ONLY
  // path that destroys, and its dialog says so with real numbers.
  const db = seed();

  const r = await disconnectSocialAccount(db, 5);

  assert.equal(r.deleted_pending, 2);
  assert.equal(r.preserved_pending, 0);
  assert.deepEqual(db._rows('submissions').map(s => s.id), [900], 'only the paid clip remains');
});

test('archiving an account with no paid clips at all still keeps everything', async () => {
  // The old code deleted the account row outright when nothing was settled,
  // which is exactly the case a brand-new clipper is in -- the most likely
  // person to be archived, and the one with the most to lose.
  const db = makeSqliteD1({
    clippers: [{ id: 7, username: 'n', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }],
    campaigns: [{ id: 3, name: 'C', cpm: 40, budget: 100000, status: 'active',
                  created_at: NOW, min_views: 1000, allowed_platforms: 'instagram' }],
    social_accounts: [{ id: 8, clipper_id: 7, platform: 'instagram', external_id: 'ig8',
                        username: 'newbie', account_type: 'BUSINESS', access_token: 't',
                        status: 'connected', connected_at: NOW, auto_import: 1 }],
    participations: [{ id: 9, clipper_id: 7, campaign_id: 3, status: 'active', joined_at: NOW, account_id: 8 }],
    submissions: [
      { id: 910, clipper_id: 7, campaign_id: 3, account_id: 8, platform: 'instagram',
        ig_media_id: 'm910', permalink: 'p910', views: 22000, earning: 880, status: 'active', created_at: NOW }
    ]
  });

  const r = await disconnectSocialAccount(db, 8, { preserveClips: true });

  assert.equal(r.account_row_kept, true);
  assert.equal(db._rows('social_accounts').length, 1);
  assert.equal(db._rows('submissions').length, 1);
  assert.equal(db._rows('submissions')[0].earning, 880, 'Rs 880 of unpaid work survives');
});
