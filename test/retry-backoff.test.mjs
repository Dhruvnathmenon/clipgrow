// Retries slow down: every rejection doubles the wait before the next try, for a
// video and for an account request alike. Pinned at three levels -- the arithmetic,
// the state the clipper's screen reads, and the routes that actually refuse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleClipper } from '../src/routes/clipper.js';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';
import { applicationState, submitApplication } from '../src/applications.js';
import { retryDelayMs, retryWindow, waitText, RETRY_BASE_MS, RETRY_CAP_MS } from '../src/backoff.js';
import { COMPLETE_PROFILE } from './helpers/profile.mjs';

const H = 60 * 60 * 1000;
const NOW = Date.now();
const SECRET = 'test-secret';

test('the wait doubles with every rejection, and stops growing at a day', () => {
  assert.equal(retryDelayMs(0), 0);
  assert.deepEqual([1, 2, 3, 4, 5].map(retryDelayMs), [1 * H, 2 * H, 4 * H, 8 * H, 16 * H]);
  assert.equal(retryDelayMs(6), RETRY_CAP_MS);
  assert.equal(retryDelayMs(500), RETRY_CAP_MS, 'a huge count cannot overflow');
  assert.equal(RETRY_BASE_MS, H);
});

test('a missing timestamp never locks anyone out', () => {
  assert.equal(retryWindow(2, null, NOW), null);
  assert.equal(retryWindow(2, 0, NOW), null);
  assert.equal(retryWindow(0, NOW, NOW), null, 'no rejections, no wait');
});

test('the wait is measured from the rejection, and ends exactly when it says', () => {
  const w = retryWindow(1, NOW - 20 * 60 * 1000, NOW);
  assert.equal(w.retry_in_ms, 40 * 60 * 1000);
  assert.equal(retryWindow(1, NOW - H, NOW), null, 'the moment it is over it is over');
  assert.equal(retryWindow(1, NOW - H - 1, NOW), null);
});

test('wait text is rounded up, never reading 0m while still waiting', () => {
  assert.equal(waitText(500), '1s');
  assert.equal(waitText(45 * 1000), '45s');
  assert.equal(waitText(61 * 1000), '2m');
  assert.equal(waitText(H), '1h');
  assert.equal(waitText(H + 12 * 60 * 1000), '1h 12m');
});

/* ------------------------------------------------------ video applications */

function world(apps = [], requests = []) {
  return makeSqliteD1({
    clippers: [{ id: 1, username: 'c1', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW, ...COMPLETE_PROFILE }],
    campaigns: [{ id: 1, name: 'C', description: '', cpm: 40, budget: 100000, status: 'active', created_at: NOW,
                  model: 'cpm', min_views: 0, allowed_platforms: 'instagram' }],
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW }],
    campaign_applications: apps,
    tester_requests: requests
  });
}
const rejected = (id, attempt, at) => ({ id, clipper_id: 1, campaign_id: 1, attempt, status: 'rejected',
  reviewer_type: 'moderator', reviewer_id: 1, reviewer_name: 'Jane', reviewer_note: 'Too dark', reviewed_at: at, created_at: at - 1000 });

test('right after a rejection the clipper must wait, and the screen is told how long', async () => {
  const s = await applicationState(world([rejected(1, 1, NOW - 10 * 60 * 1000)]), 1, 1);
  assert.equal(s.state, 'rejected');
  assert.equal(s.may_submit, false);
  assert.ok(s.retry_in_ms > 49 * 60 * 1000 && s.retry_in_ms <= 50 * 60 * 1000, `about 50 minutes left, got ${s.retry_in_ms}`);
});

test('once the wait is over they can send again', async () => {
  const s = await applicationState(world([rejected(1, 1, NOW - H - 1000)]), 1, 1);
  assert.equal(s.may_submit, true);
  assert.equal(s.retry_in_ms, null);
});

test('the second rejection doubles it', async () => {
  const s = await applicationState(world([rejected(1, 1, NOW - 5 * H), rejected(2, 2, NOW - 30 * 60 * 1000)]), 1, 1);
  assert.equal(s.rejections, 2);
  assert.ok(s.retry_in_ms > 89 * 60 * 1000, 'two hours from the second rejection, minus the 30 minutes gone');
});

test('a clipper who has never been rejected is not slowed at all', async () => {
  const s = await applicationState(world(), 1, 1);
  assert.equal(s.retry_in_ms, null);
  assert.equal(s.may_submit, true);
});

test('submitting during the wait is refused with 429 and how long is left', async () => {
  const r = await submitApplication(world([rejected(1, 1, NOW - 60 * 1000)]), { clipperId: 1, campaignId: 1, videoUrl: 'https://drive.google.com/file/d/x/view' });
  assert.equal(r.status, 429);
  assert.ok(r.retry_in_ms > 0);
  assert.match(r.error, /another video in/);
});

async function call(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('clipper', 1, SECRET);
  const req = new Request(`https://clipgrow.in${path}`, {
    method, headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  return handleClipper(req, env, new URL(req.url));
}
async function admin(env, path, method, body) {
  const cookie = await createSessionCookie('admin', 0, SECRET);
  const req = new Request(`https://clipgrow.in${path}`, { method, headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return handleAdmin(req, env, new URL(req.url));
}

test('a rejected clipper cannot get round the wait by uploading first', async () => {
  const env = { DB: world([rejected(1, 1, NOW - 60 * 1000)]), SESSION_SECRET: SECRET,
    GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', GOOGLE_REFRESH_TOKEN: 'c', GDRIVE_PENDING_FOLDER_ID: 'd' };
  const res = await call(env, '/api/clipper/campaigns/1/applications/upload-url', { method: 'POST', body: { mime_type: 'video/mp4', size_bytes: 1000 } });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('Retry-After')) > 0, 'the standard header is set too');
  assert.ok((await res.json()).retry_in_ms > 0);
});

/* ------------------------------------------------------- account requests */

const approvedVideo = { id: 9, clipper_id: 1, campaign_id: 1, attempt: 1, status: 'approved', reviewer_type: 'moderator',
  reviewer_id: 1, reviewer_name: 'Jane', reviewer_note: 'ok', reviewed_at: NOW - 5 * H, created_at: NOW - 6 * H };
const ask = env => call(env, '/api/clipper/access-request', { method: 'POST', body: { campaign_id: 1, platform: 'instagram', identifier: 'my.handle' } });

test('an account request the team rejects starts the wait, and asking straight back is refused', async () => {
  const env = { DB: world([approvedVideo]), SESSION_SECRET: SECRET, ADMIN_PASSWORD: 'x' };
  assert.equal((await ask(env)).status, 201);
  const id = env.DB._sqlite.prepare('SELECT id FROM tester_requests').get().id;

  assert.equal((await admin(env, `/api/admin/access-requests/${id}`, 'PATCH', { status: 'rejected', note: 'Not the right niche' })).status, 200);
  const row = env.DB._sqlite.prepare('SELECT rejections, rejected_at FROM tester_requests WHERE id = ?').get(id);
  assert.equal(row.rejections, 1);
  assert.ok(row.rejected_at > 0);

  const again = await ask(env);
  assert.equal(again.status, 429);
  assert.ok((await again.json()).retry_in_ms > 0);
});

test('editing the note on a request already rejected does not lengthen the wait', async () => {
  const env = { DB: world([approvedVideo]), SESSION_SECRET: SECRET, ADMIN_PASSWORD: 'x' };
  await ask(env);
  const id = env.DB._sqlite.prepare('SELECT id FROM tester_requests').get().id;
  await admin(env, `/api/admin/access-requests/${id}`, 'PATCH', { status: 'rejected', note: 'a' });
  await admin(env, `/api/admin/access-requests/${id}`, 'PATCH', { status: 'rejected', note: 'b' });
  assert.equal(env.DB._sqlite.prepare('SELECT rejections FROM tester_requests WHERE id = ?').get(id).rejections, 1);
});

test('after the wait they can ask again, and the next rejection doubles it', async () => {
  const env = { DB: world([approvedVideo]), SESSION_SECRET: SECRET, ADMIN_PASSWORD: 'x' };
  await ask(env);
  const id = env.DB._sqlite.prepare('SELECT id FROM tester_requests').get().id;
  await admin(env, `/api/admin/access-requests/${id}`, 'PATCH', { status: 'rejected' });
  env.DB._sqlite.prepare('UPDATE tester_requests SET rejected_at = ? WHERE id = ?').run(NOW - H - 1000, id);

  assert.equal((await ask(env)).status, 201, 'an hour later it goes through');
  await admin(env, `/api/admin/access-requests/${id}`, 'PATCH', { status: 'rejected' });
  assert.equal(env.DB._sqlite.prepare('SELECT rejections FROM tester_requests WHERE id = ?').get(id).rejections, 2);
  env.DB._sqlite.prepare('UPDATE tester_requests SET rejected_at = ? WHERE id = ?').run(NOW - H - 1000, id);
  assert.equal((await ask(env)).status, 429, 'an hour is no longer enough: the second wait is two');
});
