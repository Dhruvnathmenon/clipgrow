// Disconnecting an Instagram account failed with a bare "internal server error"
// for any account that had ever synced, which is all of them: every view fetch
// writes an ig_api_calls row, that table has a NOT NULL foreign key onto
// social_accounts, and disconnect DELETEs the account outright when it has no
// settled clips. The founder could not swap a clipper's account at all.
//
// Runs against real SQLite so the foreign key is genuinely enforced -- the
// hand-written fakes have no constraints and reported success on the broken code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { disconnectSocialAccount } from '../src/db.js';

const NOW = Date.now();

function seed({ settled = false, apiCalls = 2 } = {}) {
  const clip = settled
    ? { id: 900, clipper_id: 5, campaign_id: 3, account_id: 5, platform: 'instagram',
        ig_media_id: 'm900', permalink: 'p', views: 5000, earning: 200, status: 'active',
        created_at: NOW, locked_at: NOW, locked_earning: 200, lock_reason: 'paid' }
    : { id: 900, clipper_id: 5, campaign_id: 3, account_id: 5, platform: 'instagram',
        ig_media_id: 'm900', permalink: 'p', views: 141, earning: 0, status: 'active', created_at: NOW };

  return makeSqliteD1({
    clippers: [{ id: 5, username: 'c', password_hash: 'h', password_salt: 's', created_at: NOW }],
    campaigns: [{ id: 3, name: 'C', cpm: 40, budget: 100000, status: 'active',
                  created_at: NOW, min_views: 1000, allowed_platforms: 'instagram' }],
    social_accounts: [{ id: 5, clipper_id: 5, platform: 'instagram', external_id: 'ig5',
                        username: 'handle', account_type: 'BUSINESS', access_token: 't',
                        status: 'connected', connected_at: NOW, auto_import: 1 }],
    participations: [{ id: 6, clipper_id: 5, campaign_id: 3, status: 'active', joined_at: NOW, account_id: 5 }],
    participation_accounts: [{ id: 60, participation_id: 6, account_id: 5, platform: 'instagram', linked_at: NOW }],
    submissions: [clip],
    ig_api_calls: Array.from({ length: apiCalls }, (_, i) => ({ id: i + 1, social_account_id: 5, called_at: NOW }))
  });
}

test('an Instagram account with API-call history can actually be disconnected', async () => {
  const db = seed({ apiCalls: 50 });
  const r = await disconnectSocialAccount(db, 5);   // threw FOREIGN KEY before the fix
  assert.equal(r.deleted_pending, 1);
  assert.equal(db._rows('social_accounts').length, 0, 'the account row is removed');
  assert.equal(db._rows('ig_api_calls').length, 0, 'its rate-limit ledger goes with it');
});

test('a settled clip and its account row survive a disconnect', async () => {
  // Paid clips are financial history: they must still resolve to a real account.
  const db = seed({ settled: true });
  const r = await disconnectSocialAccount(db, 5);
  assert.equal(r.kept_settled, 1);
  assert.equal(r.account_row_kept, true);
  assert.equal(db._rows('submissions').length, 1, 'the paid clip stays');

  const acct = db._rows('social_accounts')[0];
  assert.equal(acct.status, 'revoked');
  assert.equal(acct.access_token, null, 'but it can no longer call the platform');
});

// submission_reviews carries a real NOT NULL FK onto submissions (migration
// 023, added after this function was first written for the moderator
// video-review workflow). A reviewed-but-unpaid clip made disconnect fail
// with the exact same FK error the two tests above already guard against
// for a different table -- found live while forcefully disconnecting a
// clipper's account in production.
test('a reviewed pending clip can still be disconnected', async () => {
  const db = seed();
  await db.prepare(
    `INSERT INTO submission_reviews
       (submission_id, verdict, feedback, reviewer_type, reviewer_id, reviewer_name, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(900, 'tick', null, 'moderator', 2, 'Mandeep', NOW).run();

  const r = await disconnectSocialAccount(db, 5);   // threw FOREIGN KEY before the fix
  assert.equal(r.deleted_pending, 1);
  assert.equal(db._rows('social_accounts').length, 0, 'the account row is removed');
  assert.equal(db._rows('submission_reviews').length, 0, 'the review of a now-gone clip goes with it');
});
