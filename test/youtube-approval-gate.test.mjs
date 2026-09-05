// A clipper reported that YouTube had no admin approval at all -- unlike
// Instagram, a channel connected straight away with nobody at ClipGrow ever
// looking at it. Traced to two deliberate-looking bypasses left over from
// when the Google Cloud project moved from Testing to Published (which only
// ever removed GOOGLE's own allowlist, never ClipGrow's own review of
// whether the channel suits the campaign):
//   - clipper.js's /api/clipper/campaigns skipped computing an `access`
//     entry for youtube at all, so the dashboard rendered a plain Connect
//     button instead of the request/wait/approved flow.
//   - youtube-auth.js's OAuth start route never called canConnect(), so
//     even a clipper who bypassed the (already-broken) UI step could
//     connect directly by hitting the URL.
//
// These tests guard both halves at the same layer admin-routes-smoke.test.mjs
// and moderator-routes-smoke.test.mjs already use: dispatching real request
// objects through the real route handlers against a real (SQLite-backed) D1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleClipper } from '../src/routes/clipper.js';
import { handleYoutubeAuth } from '../src/routes/youtube-auth.js';
import { createSessionCookie } from '../src/auth.js';

const NOW = Date.now();
const SESSION_SECRET = 'test-secret';

function seedEnv() {
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'clipper1', password_hash: 'h', password_salt: 's',
                 status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'Shorts Campaign', description: '', cpm: 40, budget: 10000,
                  status: 'active', created_at: NOW, model: 'cpm', min_views: 1000,
                  allowed_platforms: 'youtube' }],
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW }]
  });
  return {
    DB: db, SESSION_SECRET,
    YT_CLIENT_ID: 'test-client', YT_CLIENT_SECRET: 'test-secret-key'
  };
}

async function clipperRequest(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('clipper', 1, env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method,
    headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleClipper(request, env, new URL(request.url));
}

test('a YouTube-only campaign gets the same request/wait/approved states as Instagram, not a bare Connect', async () => {
  const env = seedEnv();
  const res = await clipperRequest(env, '/api/clipper/campaigns');
  assert.equal(res.status, 200);
  const { campaigns } = await res.json();
  const c = campaigns.find(x => x.id === 1);
  const yt = c.participation.access.youtube;
  assert.ok(yt, 'youtube must have a computed access entry -- it used to be omitted entirely');
  assert.equal(yt.state, 'none', 'no request submitted yet, so it starts at the same state Instagram does');
  assert.equal(yt.action, 'request', 'the clipper must be asked to request access, not offered Connect');
});

test('a confirmed request moves YouTube to approved, exactly like Instagram', async () => {
  const env = seedEnv();
  await env.DB.prepare(
    `INSERT INTO tester_requests (clipper_id, ig_username, identifier, platform, status, campaign_id, requested_at, confirmed_at)
     VALUES (1, '@mychannel', '@mychannel', 'youtube', 'confirmed', 1, ?, ?)`
  ).bind(NOW, NOW).run();

  const res = await clipperRequest(env, '/api/clipper/campaigns');
  const { campaigns } = await res.json();
  const yt = campaigns.find(x => x.id === 1).participation.access.youtube;
  assert.equal(yt.state, 'approved');
  assert.equal(yt.action, 'connect');
});

test('OAuth start refuses to begin without an approved request, even hit directly', async () => {
  // This is the enforcement that actually matters -- the UI gate above is
  // just what keeps a clipper from being shown a broken button. A clipper
  // could always have hit this URL directly (an old bookmark, a shared
  // link), and before this fix it worked with zero approval on record.
  const env = seedEnv();
  const cookie = await createSessionCookie('clipper', 1, env.SESSION_SECRET);
  const request = new Request('https://clipgrow.in/api/auth/youtube/start?campaign_id=1', {
    headers: { Cookie: cookie.split(';')[0] }
  });
  const res = await handleYoutubeAuth(request, env, new URL(request.url));
  assert.equal(res.status, 302);
  const location = res.headers.get('Location');
  assert.ok(location.startsWith('/dashboard.html?yt=error'), `expected a failure redirect, got ${location}`);
  assert.ok(location.includes('code=NOT_APPROVED'), `expected NOT_APPROVED, got ${location}`);
});

test('OAuth start proceeds to Google once the request is confirmed', async () => {
  const env = seedEnv();
  await env.DB.prepare(
    `INSERT INTO tester_requests (clipper_id, ig_username, identifier, platform, status, campaign_id, requested_at, confirmed_at)
     VALUES (1, '@mychannel', '@mychannel', 'youtube', 'confirmed', 1, ?, ?)`
  ).bind(NOW, NOW).run();

  const cookie = await createSessionCookie('clipper', 1, env.SESSION_SECRET);
  const request = new Request('https://clipgrow.in/api/auth/youtube/start?campaign_id=1', {
    headers: { Cookie: cookie.split(';')[0] }
  });
  const res = await handleYoutubeAuth(request, env, new URL(request.url));
  assert.equal(res.status, 302);
  const location = res.headers.get('Location');
  assert.ok(location.includes('accounts.google.com'), `expected a redirect to Google, got ${location}`);
});
