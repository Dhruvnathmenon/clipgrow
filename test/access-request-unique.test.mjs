// Guards migration 025: a clipper reusing the same Instagram/YouTube handle
// across two different campaigns is completely normal and must succeed.
// Before the fix, tester_requests' UNIQUE(clipper_id, ig_username) had no
// campaign_id in it, so the second request's INSERT collided with the
// first and threw a raw SQLite error -- surfaced to the clipper as a bare
// "Internal server error".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { submitAccessRequest, getAccessRequest } from '../src/access.js';

const NOW = Date.now();

function seedEnv() {
  return makeSqliteD1({
    clippers: [{ id: 1, username: 'clipper1', password_hash: 'h', password_salt: 's',
                 status: 'active', created_at: NOW }],
    campaigns: [
      { id: 1, name: 'Campaign One', description: '', cpm: 40, budget: 10000,
        status: 'active', created_at: NOW, model: 'cpm', min_views: 1000, allowed_platforms: 'instagram' },
      { id: 2, name: 'Campaign Two', description: '', cpm: 40, budget: 10000,
        status: 'active', created_at: NOW, model: 'cpm', min_views: 1000, allowed_platforms: 'instagram' }
    ]
  });
}

test('the same handle can be requested for a second campaign without colliding', async () => {
  const db = seedEnv();
  const first = await submitAccessRequest(db, {
    clipperId: 1, campaignId: 1, platform: 'instagram', identifier: 'sameclips'
  });
  assert.equal(first.ok, true);

  // This used to throw a raw SQLite UNIQUE-constraint error.
  const second = await submitAccessRequest(db, {
    clipperId: 1, campaignId: 2, platform: 'instagram', identifier: 'sameclips'
  });
  assert.equal(second.ok, true);

  const reqOne = await getAccessRequest(db, 1, 1, 'instagram');
  const reqTwo = await getAccessRequest(db, 1, 2, 'instagram');
  assert.equal(reqOne.campaign_id, 1);
  assert.equal(reqTwo.campaign_id, 2);
  assert.notEqual(reqOne.id, reqTwo.id);
});

test('re-requesting the same campaign+platform still updates in place, not a duplicate row', async () => {
  const db = seedEnv();
  await submitAccessRequest(db, { clipperId: 1, campaignId: 1, platform: 'instagram', identifier: 'first' });
  await submitAccessRequest(db, { clipperId: 1, campaignId: 1, platform: 'instagram', identifier: 'corrected' });

  const { results } = await db.prepare(
    'SELECT * FROM tester_requests WHERE clipper_id = 1 AND campaign_id = 1'
  ).all();
  assert.equal(results.length, 1);
  assert.equal(results[0].identifier, 'corrected');
});
