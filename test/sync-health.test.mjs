// GET /api/admin/sync-health -- every active clip inside its 7-day window
// whose views aren't moving, grouped by reason, with whose job the fix is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const SECRET = 'test-secret';

async function adminReq(env, path) {
  const cookie = await createSessionCookie('admin', 'admin', SECRET);
  const req = new Request(`https://clipgrow.in${path}`, { headers: { Cookie: cookie.split(';')[0] } });
  return handleAdmin(req, env, new URL(req.url));
}

const clip = (id, o = {}) => ({
  id, clipper_id: 1, campaign_id: 1, account_id: 1, platform: 'instagram', ig_media_id: 'm' + id,
  permalink: 'https://instagram.com/reel/r' + id, views: 500, status: 'active',
  created_at: NOW - 2 * DAY, last_synced_at: NOW - DAY, last_ok_sync_at: NOW - DAY, eligible: 1, ...o
});

function seed(clips) {
  return {
    DB: makeSqliteD1({
      clippers: [{ id: 1, username: 'c1', password_hash: 'h', password_salt: 's', status: 'active',
                   display_name: 'Clipper One', contact_number: '+919876543210', created_at: NOW }],
      campaigns: [{ id: 1, name: 'Camp', description: '', cpm: 50, budget: 100000, status: 'active',
                    created_at: NOW, model: 'cpm', min_views: 100, allowed_platforms: 'instagram' }],
      social_accounts: [{ id: 1, clipper_id: 1, platform: 'instagram', username: 'ig1', external_id: 'e1',
                          status: 'connected', access_token: 't', auto_import: 1, connected_at: NOW }],
      submissions: clips
    }),
    SESSION_SECRET: SECRET, ADMIN_PASSWORD: 'x'
  };
}

test('groups non-syncing clips by reason with an owner for each', async () => {
  const env = seed([
    clip(1, { sync_error: 'MEDIA_NOT_FOUND' }),                 // removed -> you
    clip(2, { sync_error: 'PRE_CONVERSION_MEDIA' }),            // no_insights -> you
    clip(3, { sync_error: 'TOKEN_EXPIRED' }),                   // reconnect -> clipper
    clip(4, { sync_error: null, last_ok_sync_at: null, created_at: NOW - 2 * DAY }), // verified (old) -> nobody
    clip(5, { sync_error: null, last_ok_sync_at: NOW - 60 * 1000 }), // healthy 'tracking' -- excluded
    clip(6, { locked_at: NOW, locked_earning: 100, lock_reason: 'paid' }), // locked -- excluded
    clip(7, { created_at: NOW - 10 * DAY })                     // past 7-day window -- excluded
  ]);

  const res = await adminReq(env, '/api/admin/sync-health');
  assert.equal(res.status, 200);
  const { groups, total } = await res.json();

  const byState = Object.fromEntries(groups.map(g => [g.state, g]));
  assert.ok(byState.removed, 'MEDIA_NOT_FOUND clip is grouped');
  assert.equal(byState.removed.who, 'you');
  assert.equal(byState.no_insights.who, 'you');
  assert.equal(byState.reconnect.who, 'clipper');
  assert.equal(byState.verified.who, 'nobody');

  assert.equal(total, 4, 'the healthy, locked, and out-of-window clips are all excluded');
  // Contact info rides along so the "message the clipper" buttons work.
  assert.equal(byState.reconnect.clips[0].contact_number, '+919876543210');
  assert.ok(byState.reconnect.clips[0].message, 'a plain-English explanation is attached');
});

test('a brand-new clip waiting for its first sync is not flagged', async () => {
  const env = seed([
    clip(1, { sync_error: null, last_ok_sync_at: null, created_at: NOW - 60 * 60 * 1000 }) // 1h old
  ]);
  const res = await adminReq(env, '/api/admin/sync-health');
  const { total } = await res.json();
  assert.equal(total, 0, 'under 6h old and never synced -> still expected, not listed');
});

test('nothing wrong -> empty groups', async () => {
  const env = seed([clip(1, { last_ok_sync_at: NOW - 60 * 1000 })]);
  const res = await adminReq(env, '/api/admin/sync-health');
  const { groups, total } = await res.json();
  assert.equal(total, 0);
  assert.deepEqual(groups, []);
});
