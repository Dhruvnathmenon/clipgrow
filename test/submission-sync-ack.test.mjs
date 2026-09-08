// Two things this feature must get right, both reproduced directly against
// the real route + real schema rather than asserted from reading the code:
//
// 1. A sync_error that will never change (MEDIA_NOT_FOUND / PRE_CONVERSION_MEDIA,
//    src/clipstate.js's TERMINAL_SYNC_ERRORS) never counts as an open issue on
//    the Overview banner -- that already existed, this guards it against
//    regressing now that the exclusion is a shared constant instead of three
//    copy-pasted tuples.
// 2. A different, real sync_error DOES count as an open issue -- until the
//    admin acknowledges it (migration 029's sync_error_acknowledged_as), at
//    which point it stops counting, and counts again the moment sync_error
//    actually changes to something else. Mirrors the exact "fails open,
//    reopens on real change" guarantee account-issue-consistency.test.mjs
//    already proves for social_accounts' own acknowledge columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';

const NOW = Date.now();
const SESSION_SECRET = 'test-secret';

async function adminRequest(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('admin', 'admin', env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method,
    headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleAdmin(request, env, new URL(request.url));
}

function seedEnv(subs) {
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'clipper1', password_hash: 'h', password_salt: 's',
                 status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'Test Campaign', description: '', cpm: 40, budget: 10000,
                  status: 'active', created_at: NOW, model: 'cpm', min_views: 1000,
                  allowed_platforms: 'instagram' }],
    submissions: subs
  });
  return { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
}

const sub = (id, overrides = {}) => ({
  id, clipper_id: 1, campaign_id: 1, platform: 'instagram', ig_media_id: 'm' + id,
  permalink: 'https://instagram.com/p/' + id, views: 0, earning: 0, status: 'active',
  created_at: NOW, ...overrides
});

test('MEDIA_NOT_FOUND and PRE_CONVERSION_MEDIA never count as open issues on the Overview banner', async () => {
  const env = seedEnv([
    sub(1, { sync_error: 'MEDIA_NOT_FOUND' }),
    sub(2, { sync_error: 'PRE_CONVERSION_MEDIA' })
  ]);
  const { overview } = await adminRequest(env, '/api/admin/overview').then(r => r.json());
  assert.equal(overview.submissions_with_errors, 0);
});

test('a real sync error counts as an open issue until acknowledged', async () => {
  const env = seedEnv([sub(1, { sync_error: 'SOME_TRANSIENT_THING' })]);
  const before = await adminRequest(env, '/api/admin/overview').then(r => r.json());
  assert.equal(before.overview.submissions_with_errors, 1);

  const ack = await adminRequest(env, '/api/admin/submissions/1/acknowledge-sync-error', {
    method: 'PATCH', body: { acknowledge: true }
  });
  assert.equal(ack.status, 200);

  const after = await adminRequest(env, '/api/admin/overview').then(r => r.json());
  assert.equal(after.overview.submissions_with_errors, 0, 'acknowledged issue should stop counting');
});

test('a genuinely new sync error re-opens even after the old one was acknowledged', async () => {
  const env = seedEnv([sub(1, { sync_error: 'SOME_TRANSIENT_THING' })]);
  await adminRequest(env, '/api/admin/submissions/1/acknowledge-sync-error', {
    method: 'PATCH', body: { acknowledge: true }
  });
  // A fresh, different problem on the same clip -- not the one dismissed.
  await env.DB.prepare("UPDATE submissions SET sync_error = 'A_DIFFERENT_PROBLEM' WHERE id = 1").run();

  const { overview } = await adminRequest(env, '/api/admin/overview').then(r => r.json());
  assert.equal(overview.submissions_with_errors, 1, 'a new error must not stay silenced by an old ack');
});

test('un-acknowledging (Unflag) brings the issue back immediately', async () => {
  const env = seedEnv([sub(1, { sync_error: 'SOME_TRANSIENT_THING' })]);
  await adminRequest(env, '/api/admin/submissions/1/acknowledge-sync-error', {
    method: 'PATCH', body: { acknowledge: true }
  });
  const unflag = await adminRequest(env, '/api/admin/submissions/1/acknowledge-sync-error', {
    method: 'PATCH', body: { acknowledge: false }
  });
  assert.equal(unflag.status, 200);

  const { overview } = await adminRequest(env, '/api/admin/overview').then(r => r.json());
  assert.equal(overview.submissions_with_errors, 1);
});

test('acknowledging a video with no sync issue is refused rather than silently no-op', async () => {
  const env = seedEnv([sub(1)]); // no sync_error at all
  const res = await adminRequest(env, '/api/admin/submissions/1/acknowledge-sync-error', {
    method: 'PATCH', body: { acknowledge: true }
  });
  assert.equal(res.status, 400);
});

test('acknowledging a submission that does not exist 404s', async () => {
  const env = seedEnv([sub(1, { sync_error: 'X' })]);
  const res = await adminRequest(env, '/api/admin/submissions/999/acknowledge-sync-error', {
    method: 'PATCH', body: { acknowledge: true }
  });
  assert.equal(res.status, 404);
});

test('the campaign detail endpoint returns sync_error_acknowledged_as so the UI can tell Skip apart from Unflag', async () => {
  const env = seedEnv([sub(1, { sync_error: 'SOME_TRANSIENT_THING' })]);
  await adminRequest(env, '/api/admin/submissions/1/acknowledge-sync-error', {
    method: 'PATCH', body: { acknowledge: true }
  });
  const { submissions } = await adminRequest(env, '/api/admin/campaigns/1').then(r => r.json());
  assert.equal(submissions[0].sync_error_acknowledged_as, 'SOME_TRANSIENT_THING');
});
