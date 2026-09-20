// The kill switch around the video-review gate, and who gets carried over
// when it is switched on.
//
// The two things that would hurt most in production are exactly what this
// pins: (1) switching the gate ON must never strand someone who was already
// past step 1 in the old flow, and (2) with it OFF, nothing about connecting
// an account may change at all -- that is what makes deploying the feature
// safe before anyone is ready for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleClipper } from '../src/routes/clipper.js';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';
import { grandfatherExisting, gatePreview, applicationState } from '../src/applications.js';
import { flagEnabled, APPLICATIONS_GATE } from '../src/feature-flags.js';

const NOW = Date.now();
const SESSION_SECRET = 'test-secret';

const clipper = id => ({ id, username: `c${id}`, password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW });

// Five clippers, one campaign each, one per situation the old flow could leave
// someone in. The comments say what each is.
function world(flag) {
  const db = makeSqliteD1({
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
  // The migration seeds the row as off. null == the row is missing entirely.
  if (flag == null) db._sqlite.exec("DELETE FROM feature_flags");
  else db._sqlite.exec(`UPDATE feature_flags SET enabled = ${flag ? 1 : 0} WHERE key = 'applications_gate'`);
  return db;
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

test('with the gate off, connecting an account works exactly as it always did', async () => {
  const e = env(world(0));
  const res = await connectAs(e, 4);
  assert.equal(res.status, 201, 'a clipper with no video review is not blocked while the gate is off');
});

test('a missing flag row reads as off, so a broken flag store cannot lock anyone out', async () => {
  const e = env(world(null));
  assert.equal(await flagEnabled(e.DB, APPLICATIONS_GATE), false);
  assert.equal((await connectAs(e, 4)).status, 201);
});

test('a flag read that throws reads as off', async () => {
  const broken = { prepare() { throw new Error('D1 is down'); } };
  assert.equal(await flagEnabled(broken, APPLICATIONS_GATE), false);
});

test('switching on carries over connected and approved-but-unconnected, and no one else', async () => {
  const db = world(0);
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

test('carrying over is safe to repeat and never overwrites a real review', async () => {
  const db = world(0);
  // Clipper 4 has already been through the new process and was rejected.
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

test('the preview counts exactly what switching on would do', async () => {
  const db = world(0);
  const p = await gatePreview(db);
  assert.deepEqual(p, { carried_over_connected: 1, carried_over_to_connect_step: 1, start_at_step_one: 2 });
  const r = await grandfatherExisting(db);
  assert.equal(r.carried_over, p.carried_over_connected + p.carried_over_to_connect_step);
});

test('the admin switch carries people over before it turns the gate on', async () => {
  const e = env(world(0));
  const cookie = await createSessionCookie('admin', 0, e.SESSION_SECRET);
  const post = enabled => handleAdmin(new Request('https://clipgrow.in/api/admin/applications-gate', {
    method: 'POST', headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled })
  }), e, new URL('https://clipgrow.in/api/admin/applications-gate'));

  assert.equal((await post('yes')).status, 400, 'anything but a real boolean is refused');

  const on = await post(true);
  assert.equal(on.status, 200);
  assert.equal((await on.json()).carried_over, 2);
  assert.equal(await flagEnabled(e.DB, APPLICATIONS_GATE), true);

  // The point of the ordering: the moment it is on, existing clippers are covered.
  assert.equal((await connectAs(e, 1)).status, 201, 'a connected clipper is not locked out');
  assert.equal((await connectAs(e, 2)).status, 201, 'nor one approved and waiting to connect');
  assert.equal((await connectAs(e, 4)).status, 403, 'while a clipper who never applied is stopped');

  // And it turns straight back off.
  assert.equal((await post(false)).status, 200);
  assert.equal((await connectAs(e, 3)).status, 201, 'off means the old flow again');
});

test('an old request approved after the gate is on still cannot connect without a reviewed video', async () => {
  // Clipper 3's request was filed before the review existed and is still with
  // the admin. Approving it must not hand them a working connect link.
  const e = env(world(0));
  await grandfatherExisting(e.DB);
  await e.DB.prepare('UPDATE feature_flags SET enabled = 1').run();
  await e.DB.prepare("UPDATE tester_requests SET status = 'confirmed' WHERE clipper_id = 3").run();

  const { canConnect } = await import('../src/access.js');
  const r = await canConnect(e.DB, 3, 1, 'instagram');
  assert.equal(r.allowed, false);
  assert.equal(r.state, 'needs_video');
  assert.equal((await canConnect(e.DB, 2, 1, 'instagram')).allowed, true, 'while the carried-over clipper is unaffected');

  await e.DB.prepare('UPDATE feature_flags SET enabled = 0').run();
  assert.equal((await canConnect(e.DB, 3, 1, 'instagram')).allowed, true, 'and with the gate off it is the old rule again');
});
