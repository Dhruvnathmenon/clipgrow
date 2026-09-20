// The video-review requirement, and who was carried over when it went live.
//
// The review is always on: there is no switch. What matters most is that it
// cannot be walked around (an old request approved later must not hand out a
// connect link), and that the one-time carry-over never strands someone who
// was already past step 1 in the old flow, nor overwrites a real review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleClipper } from '../src/routes/clipper.js';
import { createSessionCookie } from '../src/auth.js';
import { grandfatherExisting, applicationState } from '../src/applications.js';
import { canConnect } from '../src/access.js';
import { COMPLETE_PROFILE } from './helpers/profile.mjs';

const NOW = Date.now();
const SESSION_SECRET = 'test-secret';

const clipper = id => ({ id, username: `c${id}`, password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW, ...COMPLETE_PROFILE });

// Five clippers, one campaign each, one per situation the old flow could leave
// someone in. The comments say what each is.
function world() {
  return makeSqliteD1({
    clippers: [1, 2, 3, 4, 5].map(clipper),
    campaigns: [{ id: 1, name: 'C', description: '', cpm: 40, budget: 100000, status: 'active',
                  created_at: NOW, model: 'cpm', min_views: 0, allowed_platforms: 'instagram' }],
    participations: [
      { id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW },   // connected
      { id: 2, clipper_id: 2, campaign_id: 1, status: 'active', joined_at: NOW },   // approved, not connected
      { id: 3, clipper_id: 3, campaign_id: 1, status: 'active', joined_at: NOW },   // request still waiting
      { id: 4, clipper_id: 4, campaign_id: 1, status: 'active', joined_at: NOW },   // joined only
      { id: 5, clipper_id: 5, campaign_id: 1, status: 'kicked', joined_at: NOW }    // removed
    ],
    social_accounts: [{ id: 1, clipper_id: 1, platform: 'instagram', external_id: 'ig1', username: 'a', status: 'connected', connected_at: NOW }],
    participation_accounts: [{ id: 1, participation_id: 1, account_id: 1, platform: 'instagram', linked_at: NOW }],
    tester_requests: [
      { id: 1, clipper_id: 2, ig_username: 'b', status: 'confirmed', campaign_id: 1, requested_at: NOW, platform: 'instagram', identifier: 'b' },
      { id: 2, clipper_id: 3, ig_username: 'c', status: 'requested', campaign_id: 1, requested_at: NOW, platform: 'instagram', identifier: 'c' }
    ]
  });
}

const env = db => ({ DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' });

async function connectAs(e, clipperId) {
  const cookie = await createSessionCookie('clipper', clipperId, e.SESSION_SECRET);
  const request = new Request('https://clipgrow.in/api/clipper/access-request', {
    method: 'POST', headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaign_id: 1, platform: 'instagram', identifier: 'my.handle' })
  });
  return handleClipper(request, e, new URL(request.url));
}

test('a clipper who never applied cannot connect an account', async () => {
  const e = env(world());
  assert.equal((await connectAs(e, 4)).status, 403);
});

test('carry-over covers connected and approved-but-unconnected, and no one else', async () => {
  const db = world();
  const r = await grandfatherExisting(db);
  assert.equal(r.carried_over, 2);

  const state = async id => (await applicationState(db, id, 1)).state;
  assert.equal(await state(1), 'approved', 'connected: fully through, carries on');
  assert.equal(await state(2), 'approved', 'approved but not connected: lands at the connect step');
  assert.equal(await state(3), 'none', 'a request still waiting on the admin starts at step 1');
  assert.equal(await state(4), 'none', 'joined only: starts at step 1');
  assert.equal(await state(5), 'none', 'a removed clipper is not resurrected');

  const two = await applicationState(db, 2, 1);
  assert.equal(two.may_connect, true, 'so the approved-but-unconnected clipper can go straight to step 2');
});

test('carry-over is safe to repeat and never overwrites a real review', async () => {
  const db = world();
  // Clipper 4 has already been through the review and was rejected.
  await db.prepare(
    `INSERT INTO campaign_applications (clipper_id, campaign_id, attempt, status, reviewer_note, created_at)
     VALUES (4, 1, 1, 'rejected', 'Too dark', ?)`).bind(NOW).run();
  await db.prepare(
    `INSERT INTO tester_requests (clipper_id, ig_username, status, campaign_id, requested_at, platform, identifier)
     VALUES (4, 'x', 'confirmed', 1, ?, 'instagram', 'x')`).bind(NOW).run();

  await grandfatherExisting(db);
  const again = await grandfatherExisting(db);
  assert.equal(again.carried_over, 0, 'a second run adds nothing');
  const s = await applicationState(db, 4, 1);
  assert.equal(s.state, 'rejected', 'their real rejection stands, whatever their old request said');
});

test('an old request approved later still cannot connect without a reviewed video', async () => {
  // Clipper 3's request was filed before the review existed and is still with
  // the admin. Approving it must not hand them a working connect link.
  const e = env(world());
  await grandfatherExisting(e.DB);
  await e.DB.prepare("UPDATE tester_requests SET status = 'confirmed' WHERE clipper_id = 3").run();

  const r = await canConnect(e.DB, 3, 1, 'instagram');
  assert.equal(r.allowed, false);
  assert.equal(r.state, 'needs_video');
  assert.equal((await canConnect(e.DB, 2, 1, 'instagram')).allowed, true, 'while the carried-over clipper is unaffected');
});

test('the connect step opens the moment a video is approved', async () => {
  const e = env(world());
  await e.DB.prepare(
    `INSERT INTO campaign_applications (clipper_id, campaign_id, attempt, status, created_at, reviewed_at)
     VALUES (4, 1, 1, 'approved', ?, ?)`).bind(NOW, NOW).run();
  assert.equal((await connectAs(e, 4)).status, 201);
});
