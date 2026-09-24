// Creating and editing a campaign moves real money: CPM, budget, the minimum and the
// per-video cap decide what every unpaid clip is worth, all at once. These pin the
// ways a slip of the hand used to be accepted quietly.
//
//   * "1e999" became a budget of Infinity.
//   * "2,000" typed as the per-video cap was unusable, so maxPayoutPerVideo read it as
//     "no cap" and the campaign was re-priced without one -- with a success message.
//   * A CPM of 0 was accepted on edit and priced every unpaid clip at Rs 0.
//   * A budget below what had already been paid out was accepted.
//   * Setting the status by hand did not reconcile it with the budget arithmetic.
//   * An edit that changed thousands of rupees of pending earnings said "updated".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';

const NOW = Date.now();
const DRIVE_FILE = 'https://drive.google.com/file/d/1AbC/view?usp=sharing';
const DRIVE_FOLDER = 'https://drive.google.com/drive/folders/1XyZ';
const SECRET = 'test-secret';

async function admin(env, path, method, body) {
  const cookie = await createSessionCookie('admin', 'admin', SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method, headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return handleAdmin(request, env, new URL(request.url));
}

/** One campaign (cpm 50, budget 1000) with one paid clip and one open clip. */
function world({ budget = 1000, blueprint = '{}' } = {}) {
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'sam.k', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'Mali', cpm: 50, budget, status: 'active', created_at: NOW, min_views: 1000,
                  allowed_platforms: 'instagram', blueprint_json: blueprint }],
    submissions: [
      // Paid: 4,000 views settled at Rs 200.
      { id: 1, clipper_id: 1, campaign_id: 1, platform: 'instagram', ig_media_id: 'a', permalink: 'pa', views: 4000,
        earning: 200, clipper_earning: null, status: 'active', eligible: 1, created_at: NOW - 5000, posted_at: NOW - 5000,
        locked_at: NOW - 4000, locked_earning: 200, lock_reason: 'paid' },
      // Open: 10,000 views = Rs 500 at cpm 50.
      { id: 2, clipper_id: 1, campaign_id: 1, platform: 'instagram', ig_media_id: 'b', permalink: 'pb', views: 10000,
        earning: 500, clipper_earning: 500, status: 'active', eligible: 1, created_at: NOW - 3000, posted_at: NOW - 3000 }
    ]
  });
  return { DB: db, SESSION_SECRET: SECRET, ADMIN_PASSWORD: 'x' };
}
const row = (env, id = 2) => env.DB._sqlite.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
const camp = (env) => env.DB._sqlite.prepare('SELECT * FROM campaigns WHERE id = 1').get();

const goodCreate = { name: 'New', cpm: 50, budget: 5000, reference_links: [DRIVE_FILE], raw_sources: [DRIVE_FOLDER] };

/* ---------------------------------------------------------------- create */

test('create refuses a CPM or budget that is not a finite number above zero', async () => {
  const env = world();
  for (const bad of ['1e999', 'abc', '', -5, 0, null, {}, [], Infinity]) {
    for (const field of ['cpm', 'budget']) {
      const res = await admin(env, '/api/admin/campaigns', 'POST', { ...goodCreate, [field]: bad });
      assert.equal(res.status, 400, `${field}=${JSON.stringify(bad)} must be refused`);
    }
  }
  assert.equal(env.DB._sqlite.prepare('SELECT COUNT(*) AS n FROM campaigns').get().n, 1, 'nothing was created');
});

test('create refuses a per-video cap that is unusable, and accepts none or a real number', async () => {
  const env = world();
  for (const bad of ['2,000', '-5', 'abc', 0, -1]) {
    const res = await admin(env, '/api/admin/campaigns', 'POST', { ...goodCreate, max_payout: bad });
    assert.equal(res.status, 400, `max_payout=${JSON.stringify(bad)} must be refused`);
    assert.match((await res.json()).error, /per video/i);
  }
  for (const ok of [undefined, null, '', 2000, '2000']) {
    const res = await admin(env, '/api/admin/campaigns', 'POST', { ...goodCreate, max_payout: ok });
    assert.equal(res.status, 201, `max_payout=${JSON.stringify(ok)} is fine`);
  }
});

test('create refuses a typed but unusable minimum instead of swapping in the default', async () => {
  const env = world();
  const res = await admin(env, '/api/admin/campaigns', 'POST', { ...goodCreate, min_views: -5 });
  assert.equal(res.status, 400);
  const ok = await admin(env, '/api/admin/campaigns', 'POST', { ...goodCreate });   // left out: the default
  assert.equal(ok.status, 201);
  assert.equal(env.DB._sqlite.prepare('SELECT min_views FROM campaigns ORDER BY id DESC LIMIT 1').get().min_views, 1000);
});

/* ------------------------------------------------------------------ edit */

test('edit refuses a CPM of zero, a budget of zero and junk, and changes nothing', async () => {
  const env = world();
  for (const [field, bad] of [['cpm', 0], ['cpm', 'abc'], ['cpm', -1], ['budget', 0], ['budget', 'abc'], ['min_views', -1], ['min_views', '']]) {
    const res = await admin(env, '/api/admin/campaigns/1', 'PATCH', { [field]: bad });
    assert.equal(res.status, 400, `${field}=${JSON.stringify(bad)} must be refused`);
  }
  const c = camp(env);
  assert.equal(c.cpm, 50); assert.equal(c.budget, 1000); assert.equal(c.min_views, 1000);
  assert.equal(row(env).earning, 500, 'and no clip was re-priced');
});

test('edit will not remove the per-video cap by accident', async () => {
  const env = world({ blueprint: JSON.stringify({ max_payout: 2000 }) });
  const res = await admin(env, '/api/admin/campaigns/1', 'PATCH', { max_payout: '2,000' });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(camp(env).blueprint_json).max_payout, 2000, 'the cap stands');

  // Emptying it on purpose still works: that is how "no limit" is said.
  const cleared = await admin(env, '/api/admin/campaigns/1', 'PATCH', { max_payout: null });
  assert.equal(cleared.status, 200);
});

test('edit will not set a budget below what has already been paid out', async () => {
  const env = world();                                    // Rs 200 already paid
  const low = await admin(env, '/api/admin/campaigns/1', 'PATCH', { budget: 150 });
  assert.equal(low.status, 409);
  assert.match((await low.json()).error, /already been paid out/);
  assert.equal(camp(env).budget, 1000);

  const exact = await admin(env, '/api/admin/campaigns/1', 'PATCH', { budget: 200 });
  assert.equal(exact.status, 200, 'exactly what was paid is allowed: it leaves nothing for unpaid clips, on purpose');
  assert.equal(row(env).earning, 0, 'and the unpaid clip is priced at nothing, as the arithmetic says');
});

test('edit reports what it did to unpaid earnings, and paid clips never move', async () => {
  const env = world();
  const res = await admin(env, '/api/admin/campaigns/1', 'PATCH', { cpm: 25 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.repriced, { clips: 1, pending_before: 500, pending_after: 250 });
  assert.equal(row(env).earning, 250);
  const paid = row(env, 1);
  assert.equal(paid.locked_earning, 200, 'a paid clip is history');
  assert.equal(paid.earning, 200);
});

test('editing something unrelated leaves prices exactly where they were', async () => {
  const env = world();
  const res = await admin(env, '/api/admin/campaigns/1', 'PATCH', { name: 'Renamed' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).repriced, undefined, 'nothing was re-priced, so nothing is reported');
  assert.equal(row(env).earning, 500);
});

test('setting a status by hand is reconciled with the budget at once', async () => {
  // Budget 700: Rs 200 paid + Rs 500 open = exactly full.
  const env = world({ budget: 700 });
  await admin(env, '/api/admin/campaigns/1', 'PATCH', { status: 'completed' });
  assert.equal(camp(env).status, 'completed');

  // Reopening a campaign with no budget left: it must read as full straight away,
  // not "active" until some later refresh happens to finish.
  const reopened = await admin(env, '/api/admin/campaigns/1', 'PATCH', { status: 'active' });
  assert.equal(reopened.status, 200);
  assert.equal(camp(env).status, 'budget_full');

  // And a hand-set budget_full on a campaign that has room is corrected the same way.
  await admin(env, '/api/admin/campaigns/1', 'PATCH', { budget: 5000 });
  const forced = await admin(env, '/api/admin/campaigns/1', 'PATCH', { status: 'budget_full' });
  assert.equal(forced.status, 200);
  assert.equal(camp(env).status, 'active', 'budget_full is derived from the budget, so it cannot be forced on a campaign with room');
});

test('a campaign marked over stays over: pricing never reopens it', async () => {
  const env = world({ budget: 5000 });
  await admin(env, '/api/admin/campaigns/1', 'PATCH', { status: 'completed' });
  await admin(env, '/api/admin/campaigns/1', 'PATCH', { budget: 9000 });
  assert.equal(camp(env).status, 'completed');
});

test('lowering the minimum tells the admin how many clips closed at Rs 0 would now qualify', async () => {
  const env = world();
  // A clip that was written off at zero when the minimum was 5,000: 3,000 views.
  env.DB._sqlite.prepare(
    `INSERT INTO submissions (id, clipper_id, campaign_id, platform, ig_media_id, permalink, views, earning, clipper_earning,
       status, eligible, created_at, posted_at, locked_at, locked_earning, lock_reason)
     VALUES (3, 1, 1, 'instagram', 'c', 'pc', 3000, 0, 0, 'active', 1, ?, ?, ?, 0, 'below_min')`
  ).run(NOW - 2000, NOW - 2000, NOW - 1000);

  const res = await admin(env, '/api/admin/campaigns/1', 'PATCH', { min_views: 2000 });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).repriced.closed_now_eligible, 1);
  assert.equal(row(env, 3).lock_reason, 'below_min', 'it is still closed: reopening is a deliberate act, never automatic');

  const again = await admin(env, '/api/admin/campaigns/1', 'PATCH', { min_views: 9000 });
  assert.equal((await again.json()).repriced.closed_now_eligible, undefined, 'nothing to report when none would qualify');
});

test('re-sending an unchanged budget never blocks an unrelated edit, even on a campaign already paid past it', async () => {
  // The edit form sends every field every time. A campaign whose paid total somehow exceeds its
  // budget (older data) must still be renameable.
  const env = world({ budget: 150 });                       // Rs 200 already paid, budget 150
  const res = await admin(env, '/api/admin/campaigns/1', 'PATCH', { name: 'Renamed', cpm: 50, budget: 150, min_views: 1000 });
  assert.equal(res.status, 200);
  assert.equal(camp(env).name, 'Renamed');
  // Actually lowering it further is still refused.
  const lower = await admin(env, '/api/admin/campaigns/1', 'PATCH', { budget: 100 });
  assert.equal(lower.status, 409);
});
