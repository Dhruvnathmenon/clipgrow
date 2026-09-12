// A confirmed-dead clip (Instagram/YouTube returning MEDIA_NOT_FOUND, or
// PRE_CONVERSION_MEDIA which can never change) was being re-fetched on every
// single cron pass forever -- nothing in buildAccountItems ever stopped
// offering it, even though the platform had already given a permanent
// answer. Production had 21 such clips being wastefully retried. Three
// things fix this, each covered here:
//
// 1. buildAccountItems never queues a TERMINAL_SYNC_ERRORS clip again.
// 2. A clipper can self-heal a false-positive MEDIA_NOT_FOUND by pasting the
//    exact same link -- narrowly scoped so it can never resurrect another
//    clipper's clip, a different campaign's clip, or an admin's deliberate
//    Mark Invalid (status='disqualified').
// 3. The Overview "Needs attention" banner no longer lists an account's
//    stuck clips as a second, separate problem when that same account is
//    already listed as needing reconnection -- same root cause, counted once,
//    with its blast radius attached to the one line instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { buildAccountItems } from '../src/refresh-jobs.js';
import { handleClipper } from '../src/routes/clipper.js';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const SESSION_SECRET = 'test-secret';

async function clipperRequest(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('clipper', 1, env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method, headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleClipper(request, env, new URL(request.url));
}
async function adminRequest(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('admin', 'admin', env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method, headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleAdmin(request, env, new URL(request.url));
}

// ------------------------------------------------------- buildAccountItems

test('buildAccountItems never re-queues a MEDIA_NOT_FOUND or PRE_CONVERSION_MEDIA clip', async () => {
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'c1', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'T', cpm: 50, budget: 10000, status: 'active', created_at: NOW, min_views: 100, allowed_platforms: 'instagram' }],
    social_accounts: [{ id: 1, clipper_id: 1, platform: 'instagram', username: 'ig1', external_id: 'e1', status: 'connected', access_token: 'tok', auto_import: 0, connected_at: NOW }],
    submissions: [
      { id: 1, clipper_id: 1, campaign_id: 1, account_id: 1, platform: 'instagram', ig_media_id: 'gone', permalink: 'p1', views: 0, earning: 0, status: 'active', eligible: 1, created_at: NOW, sync_error: 'MEDIA_NOT_FOUND' },
      { id: 2, clipper_id: 1, campaign_id: 1, account_id: 1, platform: 'instagram', ig_media_id: 'pre', permalink: 'p2', views: 0, earning: 0, status: 'active', eligible: 1, created_at: NOW, sync_error: 'PRE_CONVERSION_MEDIA' },
      { id: 3, clipper_id: 1, campaign_id: 1, account_id: 1, platform: 'instagram', ig_media_id: 'live', permalink: 'p3', views: 0, earning: 0, status: 'active', eligible: 1, created_at: NOW, sync_error: null }
    ]
  });
  const account = { account_id: 1, platform: 'instagram', auto_import: 0, part_status: 'active', campaign_status: 'active' };
  const items = await buildAccountItems(db, account, { respectCooldown: false });
  assert.deepEqual(items.map(i => i.m), ['live'], 'only the clip with no permanent error is offered');
});

// ------------------------------------------------------------ resurrection

function resurrectionEnv(subOverrides = {}) {
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'c1', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW },
               { id: 2, username: 'c2', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }],
    campaigns: [
      { id: 1, name: 'Camp A', cpm: 50, budget: 10000, status: 'active', created_at: NOW, min_views: 100, allowed_platforms: 'instagram' },
      { id: 2, name: 'Camp B', cpm: 50, budget: 10000, status: 'active', created_at: NOW, min_views: 100, allowed_platforms: 'instagram' }
    ],
    participations: [
      { id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW },
      { id: 2, clipper_id: 1, campaign_id: 2, status: 'active', joined_at: NOW }
    ],
    social_accounts: [{ id: 1, clipper_id: 1, platform: 'instagram', username: 'ig1', external_id: 'ig-user-1', status: 'connected', access_token: 'tok', auto_import: 1, connected_at: NOW }],
    participation_accounts: [{ participation_id: 1, account_id: 1, platform: 'instagram', linked_at: NOW }, { participation_id: 2, account_id: 1, platform: 'instagram', linked_at: NOW }],
    submissions: [{
      id: 1, clipper_id: 1, campaign_id: 1, account_id: 1, platform: 'instagram', ig_media_id: 'media-123',
      permalink: 'https://www.instagram.com/reel/abc123/', views: 400, earning: 0, status: 'active',
      eligible: 1, created_at: NOW - DAY, sync_error: 'MEDIA_NOT_FOUND', ...subOverrides
    }]
  });
  return { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass', IG_CLIENT_ID: 'x', IG_CLIENT_SECRET: 'y' };
}

function installFetchStub({ mediaId = 'media-123', permalink = 'https://www.instagram.com/reel/abc123/', views = 2000 } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/ig-user-1/media')) {
      return new Response(JSON.stringify({
        data: [{ id: mediaId, permalink, media_type: 'VIDEO', media_product_type: 'REELS', timestamp: '2026-09-08T00:00:00+0000', thumbnail_url: null, media_url: null }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes(`/${mediaId}/insights`)) {
      return new Response(JSON.stringify({ data: [{ name: 'views', values: [{ value: views }] }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('unexpected fetch: ' + u);
  };
  return () => { globalThis.fetch = realFetch; };
}

test('pasting the same link resurrects a MEDIA_NOT_FOUND clip instead of rejecting it as a duplicate', async () => {
  const env = resurrectionEnv();
  const restore = installFetchStub({ views: 2000 });
  try {
    const res = await clipperRequest(env, '/api/clipper/submissions', {
      method: 'POST', body: { campaign_id: 1, url: 'https://www.instagram.com/reel/abc123/' }
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.match(body.message, /back/i);
    assert.equal(body.views, 2000);

    const rows = await env.DB.prepare('SELECT id, status, sync_error, views FROM submissions').all();
    assert.equal(rows.results.length, 1, 'the existing row is reused, not duplicated');
    assert.equal(rows.results[0].sync_error, null, 'the permanent error is cleared');
    assert.equal(rows.results[0].views, 2000);
  } finally { restore(); }
});

test('a clip with a real, non-permanent sync_error is still just "already submitted" -- resurrection is not a general retry button', async () => {
  const env = resurrectionEnv({ sync_error: 'TOKEN_EXPIRED' });
  const restore = installFetchStub();
  try {
    const res = await clipperRequest(env, '/api/clipper/submissions', {
      method: 'POST', body: { campaign_id: 1, url: 'https://www.instagram.com/reel/abc123/' }
    });
    assert.equal(res.status, 409);
  } finally { restore(); }
});

test('an admin-disqualified clip can never be resurrected by re-pasting its link', async () => {
  const env = resurrectionEnv({ status: 'disqualified', invalidated_reason: 'fraud' });
  const restore = installFetchStub();
  try {
    const res = await clipperRequest(env, '/api/clipper/submissions', {
      method: 'POST', body: { campaign_id: 1, url: 'https://www.instagram.com/reel/abc123/' }
    });
    assert.equal(res.status, 409, 'a deliberate admin call must never be undone by the clipper themselves');
  } finally { restore(); }
});

test('a different clipper claiming the same media still gets the ordinary duplicate rejection', async () => {
  const env = resurrectionEnv();
  const restore = installFetchStub();
  try {
    const cookie = await createSessionCookie('clipper', 2, env.SESSION_SECRET);
    const request = new Request('https://clipgrow.in/api/clipper/submissions', {
      method: 'POST', headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign_id: 1, url: 'https://www.instagram.com/reel/abc123/' })
    });
    // clipper 2 has no participation/account on campaign 1 at all, so this
    // fails earlier (no connected account) -- confirms it never even reaches
    // the resurrection branch for someone who isn't this clipper.
    const res = await handleClipper(request, env, new URL(request.url));
    assert.notEqual(res.status, 200, 'must never resurrect on another clipper\'s behalf');
  } finally { restore(); }
});

test('re-pasting the same link under a different campaign does not resurrect the original submission', async () => {
  const env = resurrectionEnv();
  const restore = installFetchStub();
  try {
    const res = await clipperRequest(env, '/api/clipper/submissions', {
      method: 'POST', body: { campaign_id: 2, url: 'https://www.instagram.com/reel/abc123/' }
    });
    assert.equal(res.status, 409, 'a clip cannot be moved to a different campaign via resurrection');
  } finally { restore(); }
});

// --------------------------------------------------- Overview de-duplication

test('an account already listed as needing reconnection is not also listed as separately "stuck" for the same clips', async () => {
  const stale = NOW - 2 * DAY;
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'c1', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'T', cpm: 50, budget: 10000, status: 'active', created_at: NOW, min_views: 100, allowed_platforms: 'instagram' }],
    social_accounts: [{ id: 1, clipper_id: 1, platform: 'instagram', username: 'ig1', external_id: 'e1', status: 'needs_reauth', last_error_code: 'TOKEN_EXPIRED', last_error_at: stale, access_token: 'tok', auto_import: 1, connected_at: NOW }],
    submissions: [
      { id: 1, clipper_id: 1, campaign_id: 1, account_id: 1, platform: 'instagram', ig_media_id: 'm1', permalink: 'p1', views: 10, earning: 0, status: 'active', eligible: 1, created_at: stale, last_ok_sync_at: stale, sync_error: 'TOKEN_EXPIRED' },
      { id: 2, clipper_id: 1, campaign_id: 1, account_id: 1, platform: 'instagram', ig_media_id: 'm2', permalink: 'p2', views: 10, earning: 0, status: 'active', eligible: 1, created_at: stale, last_ok_sync_at: stale, sync_error: 'TOKEN_EXPIRED' }
    ]
  });
  const env = { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };

  const { overview, problem_accounts, stuck_accounts } = await adminRequest(env, '/api/admin/overview').then(r => r.json());
  assert.equal(problem_accounts.length, 1, 'the account is named once, up front');
  assert.equal(problem_accounts[0].clip_count, 2, 'carrying how many clips it is holding up');
  assert.equal(stuck_accounts.length, 0, 'not repeated as a second, separate "N video(s) not syncing" problem');
  assert.equal(overview.submissions_stuck, 0, 'nor as a third, bare, unnamed fallback count');
});

test('a stuck account NOT already flagged for reconnection still shows up under stuck_accounts', async () => {
  const stale = NOW - 2 * DAY;
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'c1', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'T', cpm: 50, budget: 10000, status: 'active', created_at: NOW, min_views: 100, allowed_platforms: 'instagram' }],
    social_accounts: [{ id: 1, clipper_id: 1, platform: 'instagram', username: 'ig1', external_id: 'e1', status: 'connected', access_token: 'tok', auto_import: 1, connected_at: NOW }],
    submissions: [{ id: 1, clipper_id: 1, campaign_id: 1, account_id: 1, platform: 'instagram', ig_media_id: 'm1', permalink: 'p1', views: 10, earning: 0, status: 'active', eligible: 1, created_at: stale, last_ok_sync_at: stale, sync_error: 'SOME_TRANSIENT_THING' }]
  });
  const env = { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };

  const { problem_accounts, stuck_accounts } = await adminRequest(env, '/api/admin/overview').then(r => r.json());
  assert.equal(problem_accounts.length, 0);
  assert.equal(stuck_accounts.length, 1, 'a real, unrelated stuck clip must still surface');
});
