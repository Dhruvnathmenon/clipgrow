// Manually flagging a clip invalid (admin) and undoing a wrong flag.
//
// `disqualified` already zeroes a clip's earning and releases its budget share
// -- these routes add the required reason, the audit trail, the client-flag
// auto-close, and a live view re-check on the way back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';

const NOW = Date.now();
const SESSION_SECRET = 'test-secret';

async function adminRequest(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('admin', 'admin', SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method,
    headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleAdmin(request, env, new URL(request.url));
}

// Two active clips on a cpm=50 campaign with only enough budget for one of
// them. Clip 1 is older so it wins the whole budget under FCFS.
function seedEnv(extra = {}) {
  const db = makeSqliteD1({
    clippers: [
      { id: 1, username: 'c1', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW },
      { id: 2, username: 'c2', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }
    ],
    campaigns: [{ id: 1, name: 'Camp', description: '', cpm: 50, budget: 1000, status: 'active',
                  created_at: NOW, model: 'cpm', min_views: 100, allowed_platforms: 'instagram' }],
    participations: [
      { id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW },
      { id: 2, clipper_id: 2, campaign_id: 1, status: 'active', joined_at: NOW }
    ],
    submissions: [
      { id: 1, clipper_id: 1, campaign_id: 1, platform: 'instagram', ig_media_id: 'm1',
        permalink: 'https://instagram.com/p/1', views: 40000, earning: 1000, status: 'active',
        created_at: NOW - 2000, last_ok_sync_at: NOW - 1000 },
      { id: 2, clipper_id: 2, campaign_id: 1, platform: 'instagram', ig_media_id: 'm2',
        permalink: 'https://instagram.com/p/2', views: 40000, earning: 0, status: 'active',
        created_at: NOW - 1000, last_ok_sync_at: NOW - 1000 }
    ],
    ...extra
  });
  return { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'x', IG_CLIENT_ID: 'x', IG_CLIENT_SECRET: 'y' };
}

test('invalidate needs a reason', async () => {
  const env = seedEnv();
  const res = await adminRequest(env, '/api/admin/submissions/1/invalidate', { method: 'POST', body: {} });
  assert.equal(res.status, 400);
});

test('invalidate zeroes the clip and releases its budget to the next in line', async () => {
  const env = seedEnv();
  const res = await adminRequest(env, '/api/admin/submissions/1/invalidate',
    { method: 'POST', body: { reason: 'botted views -- flagged by Mandvee' } });
  assert.equal(res.status, 200, await res.text?.());

  const rows = env.DB._rows('submissions');
  const one = rows.find(r => r.id === 1);
  const two = rows.find(r => r.id === 2);
  assert.equal(one.status, 'disqualified');
  assert.equal(one.earning, 0, 'flagged clip earns nothing');
  assert.equal(one.invalidated_reason, 'botted views -- flagged by Mandvee');
  assert.ok(one.invalidated_at > 0);
  assert.equal(two.earning, 1000, 'the freed budget went to the next active clip');

  const log = env.DB._rows('staff_audit_log');
  assert.ok(log.some(l => l.action === 'submission_invalidated' && l.detail.includes('Mandvee')));
});

test('invalidate refuses on a clip that has already been paid', async () => {
  const env = seedEnv({
    payments: [{ id: 9, clipper_id: 1, amount: 500, paid_at: NOW, created_at: NOW }]
  });
  env.DB._sqlite.prepare(
    "UPDATE submissions SET locked_at = ?, locked_earning = 500, lock_reason = 'paid', payment_id = 9 WHERE id = 1"
  ).run(NOW);
  const res = await adminRequest(env, '/api/admin/submissions/1/invalidate', { method: 'POST', body: { reason: 'x' } });
  assert.equal(res.status, 409);
  assert.equal(env.DB._rows('submissions').find(r => r.id === 1).status, 'active');
});

test('invalidate is rejected when the clip is already flagged', async () => {
  const env = seedEnv();
  await adminRequest(env, '/api/admin/submissions/1/invalidate', { method: 'POST', body: { reason: 'first' } });
  const res = await adminRequest(env, '/api/admin/submissions/1/invalidate', { method: 'POST', body: { reason: 'again' } });
  assert.equal(res.status, 409);
});

test('a plain status PATCH can no longer disqualify, and cannot move a flagged clip', async () => {
  const env = seedEnv();
  const bad = await adminRequest(env, '/api/admin/submissions/1', { method: 'PATCH', body: { status: 'disqualified' } });
  assert.equal(bad.status, 400);

  await adminRequest(env, '/api/admin/submissions/1/invalidate', { method: 'POST', body: { reason: 'x' } });
  const locked = await adminRequest(env, '/api/admin/submissions/1', { method: 'PATCH', body: { status: 'active' } });
  assert.equal(locked.status, 409, 'a flagged clip must go back through Restore');
});

test('revalidate restores the clip and re-prices it even with no account to sync', async () => {
  const env = seedEnv();
  await adminRequest(env, '/api/admin/submissions/1/invalidate', { method: 'POST', body: { reason: 'x' } });
  assert.equal(env.DB._rows('submissions').find(r => r.id === 2).earning, 1000);

  const res = await adminRequest(env, '/api/admin/submissions/1/revalidate', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.synced, false, 'no connected account -> no live fetch, but the call still works');

  const rows = env.DB._rows('submissions');
  const one = rows.find(r => r.id === 1);
  assert.equal(one.status, 'active');
  assert.equal(one.invalidated_at, null);
  assert.equal(one.invalidated_reason, null);
  assert.equal(one.earning, 1000, 'older clip reclaims the budget under FCFS');
  assert.equal(rows.find(r => r.id === 2).earning, 0);

  const log = env.DB._rows('staff_audit_log');
  assert.ok(log.some(l => l.action === 'submission_revalidated'));
});

test('revalidate refuses when the clip is not flagged', async () => {
  const env = seedEnv();
  const res = await adminRequest(env, '/api/admin/submissions/1/revalidate', { method: 'POST' });
  assert.equal(res.status, 409);
});

// ---- the paste-a-link shortcut ------------------------------------------

function seedUrlEnv() {
  return {
    DB: makeSqliteD1({
      clippers: [{ id: 1, username: 'c1', password_hash: 'h', password_salt: 's', status: 'active',
                   display_name: 'Clipper One', created_at: NOW }],
      campaigns: [{ id: 1, name: 'Camp', description: '', cpm: 50, budget: 5000, status: 'active',
                    created_at: NOW, model: 'cpm', min_views: 100, allowed_platforms: 'instagram,youtube' }],
      participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW }],
      submissions: [
        { id: 1, clipper_id: 1, campaign_id: 1, platform: 'instagram', ig_media_id: 'IGMEDIA1',
          permalink: 'https://www.instagram.com/reel/DAbc_1-Xyz/', views: 30000, earning: 1500,
          status: 'active', created_at: NOW - 3000, last_ok_sync_at: NOW },
        { id: 2, clipper_id: 1, campaign_id: 1, platform: 'youtube', ig_media_id: 'YTVID123abc',
          permalink: 'https://www.youtube.com/shorts/YTVID123abc', views: 10000, earning: 0,
          status: 'active', created_at: NOW - 2000, last_ok_sync_at: NOW }
      ]
    }),
    SESSION_SECRET: SESSION_SECRET, ADMIN_PASSWORD: 'x'
  };
}

test('invalidate-by-url flags an Instagram clip from any link form', async () => {
  for (const link of [
    'https://www.instagram.com/reel/DAbc_1-Xyz/',
    'instagram.com/reel/DAbc_1-Xyz',
    'https://instagram.com/reel/DAbc_1-Xyz/?igsh=abc123'
  ]) {
    const env = seedUrlEnv();
    const res = await adminRequest(env, '/api/admin/submissions/invalidate-by-url',
      { method: 'POST', body: { url: link, reason: 'off-brand' } });
    assert.equal(res.status, 200, link);
    const body = await res.json();
    assert.equal(body.clipper, 'Clipper One');
    assert.equal(body.campaign, 'Camp');
    assert.equal(env.DB._rows('submissions').find(r => r.id === 1).status, 'disqualified');
  }
});

test('invalidate-by-url resolves every YouTube link shape to the same clip', async () => {
  for (const link of [
    'https://www.youtube.com/shorts/YTVID123abc',
    'https://youtu.be/YTVID123abc',
    'https://www.youtube.com/watch?v=YTVID123abc&feature=share'
  ]) {
    const env = seedUrlEnv();
    const res = await adminRequest(env, '/api/admin/submissions/invalidate-by-url',
      { method: 'POST', body: { url: link, reason: 'reused footage' } });
    assert.equal(res.status, 200, link);
    assert.equal(env.DB._rows('submissions').find(r => r.id === 2).status, 'disqualified');
  }
});

test('invalidate-by-url needs a real video link and a reason', async () => {
  const env = seedUrlEnv();
  assert.equal((await adminRequest(env, '/api/admin/submissions/invalidate-by-url',
    { method: 'POST', body: { url: 'https://example.com/x', reason: 'r' } })).status, 400);
  assert.equal((await adminRequest(env, '/api/admin/submissions/invalidate-by-url',
    { method: 'POST', body: { url: 'https://instagram.com/reel/DAbc_1-Xyz/' } })).status, 400);
});

test('invalidate-by-url returns 404 when no tracked clip matches the link', async () => {
  const env = seedUrlEnv();
  const res = await adminRequest(env, '/api/admin/submissions/invalidate-by-url',
    { method: 'POST', body: { url: 'https://www.instagram.com/reel/NOTinSystem99/', reason: 'r' } });
  assert.equal(res.status, 404);
});

test('invalidate-by-url is a no-op-with-409 on a clip already flagged', async () => {
  const env = seedUrlEnv();
  await adminRequest(env, '/api/admin/submissions/invalidate-by-url',
    { method: 'POST', body: { url: 'https://www.instagram.com/reel/DAbc_1-Xyz/', reason: 'first' } });
  const res = await adminRequest(env, '/api/admin/submissions/invalidate-by-url',
    { method: 'POST', body: { url: 'https://www.instagram.com/reel/DAbc_1-Xyz/', reason: 'again' } });
  assert.equal(res.status, 409);
});

test('revalidate does a live view re-check when the account is connected', async () => {
  const IG_USER_ID = 'ig-user-1';
  const env = seedEnv({
    social_accounts: [{ id: 1, clipper_id: 1, platform: 'instagram', username: 'ig1',
                        external_id: IG_USER_ID, status: 'connected', access_token: 'tok',
                        auto_import: 1, connected_at: NOW }]
  });
  env.DB._sqlite.prepare('UPDATE submissions SET account_id = 1 WHERE id = 1').run();
  await adminRequest(env, '/api/admin/submissions/1/invalidate', { method: 'POST', body: { reason: 'x' } });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/m1/insights')) {
      return new Response(JSON.stringify({ data: [{ name: 'views', values: [{ value: 12345 }] }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('unexpected fetch: ' + u);
  };
  try {
    const res = await adminRequest(env, '/api/admin/submissions/1/revalidate', { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.synced, true);
    assert.equal(body.views, 12345, 'the current view count was pulled in on restore');
    assert.equal(env.DB._rows('submissions').find(r => r.id === 1).views, 12345);
  } finally {
    globalThis.fetch = realFetch;
  }
});
