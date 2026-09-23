// The admin's view of step-1 verdicts: who reviewed what, and whether the people
// they let in stayed. The number that matters is `later_removed` -- it is how an
// admin finds a moderator who keeps approving the wrong people -- so it is pinned
// against every way a clipper can stop being in good standing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';
import { reviewerScorecard, reviewLog } from '../src/applications.js';

const NOW = Date.now();
const SECRET = 'test-secret';

// Six clippers, one campaign. Each is a different way a verdict can age.
function world() {
  const c = (id, status = 'active') => ({ id, username: `c${id}`, password_hash: 'h', password_salt: 's', status, created_at: NOW });
  const app = (id, clipper, status, rt, rid, rname, extra = {}) => ({
    id, clipper_id: clipper, campaign_id: 1, attempt: 1, status, reviewer_type: rt, reviewer_id: rid,
    reviewer_name: rname, reviewer_note: status === 'pending' ? null : 'note', reviewed_at: status === 'pending' ? null : NOW, created_at: NOW, ...extra
  });
  return makeSqliteD1({
    clippers: [c(1), c(2), c(3), c(4, 'disabled'), c(5), c(6), c(7)],
    campaigns: [{ id: 1, name: 'Camp', description: '', cpm: 40, budget: 1000, status: 'active', created_at: NOW, model: 'cpm', min_views: 0, allowed_platforms: 'instagram' }],
    moderators: [{ id: 1, username: 'jane', password_hash: 'h', password_salt: 's', display_name: 'Jane', status: 'active', created_at: NOW },
                 { id: 2, username: 'raj', password_hash: 'h', password_salt: 's', display_name: 'Raj', status: 'active', created_at: NOW }],
    participations: [
      { id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW },
      { id: 2, clipper_id: 2, campaign_id: 1, status: 'kicked', joined_at: NOW },   // approved, later kicked
      { id: 3, clipper_id: 3, campaign_id: 1, status: 'active', joined_at: NOW }
    ],
    campaign_applications: [
      app(1, 1, 'approved', 'moderator', 1, 'Jane'),   // stayed
      app(2, 2, 'approved', 'moderator', 1, 'Jane'),   // kicked afterwards
      app(3, 3, 'rejected', 'moderator', 1, 'Jane'),
      app(4, 4, 'approved', 'moderator', 2, 'Raj'),    // account disabled afterwards
      app(5, 5, 'approved', 'admin', null, 'Admin'),
      app(6, 6, 'approved', 'system', null, 'System', { attempt: 0 }),  // carried over: nobody reviewed it
      app(7, 7, 'pending', null, null, null)
    ]
  });
}

test('each reviewer gets their own tally, and only real reviews count', async () => {
  const s = await reviewerScorecard(world());
  const jane = s.reviewers.find(r => r.reviewer_id === 1);
  const raj = s.reviewers.find(r => r.reviewer_id === 2);
  assert.deepEqual([jane.approved, jane.rejected], [2, 1]);
  assert.deepEqual([raj.approved, raj.rejected], [1, 0]);
  assert.equal(s.reviewers.find(r => r.reviewer_type === 'admin').approved, 1);
  assert.equal(s.reviewers.some(r => r.reviewer_type === 'system'), false, 'a carry-over is not a review');
  assert.equal(s.carried_over, 1);
});

test('later_removed counts approvals that ended badly: kicked from the campaign, or the account gone', async () => {
  const s = await reviewerScorecard(world());
  assert.equal(s.reviewers.find(r => r.reviewer_id === 1).later_removed, 1, 'Jane approved one who was kicked');
  assert.equal(s.reviewers.find(r => r.reviewer_id === 2).later_removed, 1, 'Raj approved one whose account is disabled');
  assert.equal(s.reviewers.find(r => r.reviewer_type === 'admin').later_removed, 0);
});

test('a rejection never counts against the reviewer as a bad approval', async () => {
  const db = world();
  await db.prepare("UPDATE clippers SET status = 'disabled' WHERE id = 3").run();   // the rejected clipper
  const jane = (await reviewerScorecard(db)).reviewers.find(r => r.reviewer_id === 1);
  assert.equal(jane.later_removed, 1, 'unchanged: the rejected one is not an approval');
});

test('the log filters by verdict and by reviewer, and leaves carry-overs out', async () => {
  const db = world();
  const all = await reviewLog(db);
  assert.equal(all.length, 6, 'six real rows; the carry-over is excluded');
  assert.equal((await reviewLog(db, { status: 'rejected' })).length, 1);
  assert.equal((await reviewLog(db, { status: 'pending' })).length, 1);
  const janes = await reviewLog(db, { reviewer: 'moderator:1' });
  assert.equal(janes.length, 3);
  assert.ok(janes.every(r => r.reviewer_name === 'Jane'));
  assert.equal((await reviewLog(db, { reviewer: 'admin:' })).length, 1);
});

test('each log row says where the clipper stands now', async () => {
  const rows = await reviewLog(world(), { status: 'approved' });
  const byClipper = id => rows.find(r => r.clipper_id === id);
  assert.equal(byClipper(1).later_removed, 0);
  assert.equal(byClipper(2).participation_status, 'kicked');
  assert.equal(byClipper(2).later_removed, 1);
  assert.equal(byClipper(4).clipper_status, 'disabled');
  assert.equal(byClipper(4).later_removed, 1);
});

test('only an admin can read it, and the endpoint returns the scorecard and the log together', async () => {
  const env = { DB: world(), SESSION_SECRET: SECRET, ADMIN_PASSWORD: 'x' };
  const anon = await handleAdmin(new Request('https://clipgrow.in/api/admin/applications'), env, new URL('https://clipgrow.in/api/admin/applications'));
  assert.equal(anon.status, 401);

  const cookie = await createSessionCookie('admin', 0, SECRET);
  const url = 'https://clipgrow.in/api/admin/applications?status=approved&reviewer=moderator:1';
  const res = await handleAdmin(new Request(url, { headers: { Cookie: cookie.split(';')[0] } }), env, new URL(url));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.log.length, 2);
  assert.ok(Array.isArray(body.reviewers) && body.carried_over === 1);
});
