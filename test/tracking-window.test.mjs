// A clip's view-tracking lifecycle is 7 days from created_at (clipstate.js's
// TRACKING_WINDOW_MS) -- past that, its view count is final and nothing
// should spend an Instagram call checking it again.
//
// This file used to prove that the clipper's per-clip refresh endpoint
// honoured that window. That endpoint no longer exists: the hourly cron is
// the only thing that refreshes a clipper's views now, so the window is
// enforced in ONE place, buildAccountItems, and is pinned there instead
// ("a clip past its 7-day tracking window is excluded", refresh-jobs.test.mjs).
//
// What remains worth pinning here is the removal itself. A clipper-triggered
// sync is the one thing that can spend an account's 200/hour Instagram
// ceiling at an unpredictable moment -- the budget the cron needs to keep
// its hourly promise. Re-adding such a route would quietly break that
// promise rather than fail loudly, so this asserts the route is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleClipper } from '../src/routes/clipper.js';
import { createSessionCookie } from '../src/auth.js';

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_SECRET = 'test-secret';

async function clipperRequest(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('clipper', 1, env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method,
    headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleClipper(request, env, new URL(request.url));
}

function seedEnv(subCreatedAt) {
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'clipper1', password_hash: 'h', password_salt: 's',
                 status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'Test Campaign', description: '', cpm: 40, budget: 10000,
                  status: 'active', created_at: NOW, model: 'cpm', min_views: 1000,
                  allowed_platforms: 'instagram' }],
    social_accounts: [{ id: 1, clipper_id: 1, platform: 'instagram', username: 'ig1', external_id: 'ext1',
                        status: 'connected', access_token: 't', auto_import: 0, connected_at: NOW }],
    submissions: [{ id: 1, clipper_id: 1, campaign_id: 1, account_id: 1, platform: 'instagram',
                    ig_media_id: 'm1', permalink: 'https://instagram.com/p/1', views: 100, earning: 0,
                    status: 'active', eligible: 1, locked_at: null, created_at: subCreatedAt }]
  });
  return { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
}

test('there is no clipper-triggered refresh route at all any more', async () => {
  // Inside its window, so nothing about the clip itself could explain a
  // refusal -- if any handler still answered here, this would not be null.
  const env = seedEnv(NOW - 6 * DAY_MS);
  const res = await clipperRequest(env, '/api/clipper/submissions/1/refresh', { method: 'POST' });
  assert.equal(res, null,
    'no handler claims this path, so the Worker falls through to a 404 -- the hourly cron is the only refresh');
});

test('the clipper API still serves the clip list it replaced the button with', async () => {
  // The countdown-and-list dashboard is what a clipper gets instead of a
  // refresh button, so that path must keep working on its own.
  const env = seedEnv(NOW - 6 * DAY_MS);
  const res = await clipperRequest(env, '/api/clipper/submissions');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.clips.length, 1, 'the clip is still listed, with whatever the last sweep recorded');
});
