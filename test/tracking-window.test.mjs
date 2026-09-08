// A clip's view-tracking lifecycle is 7 days from created_at (clipstate.js's
// TRACKING_WINDOW_MS) -- past that, its view count is final and nothing
// should spend an Instagram call checking it again, including a clipper
// deliberately asking for one.
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

test('single-clip refresh is refused once the 7-day tracking window has closed', async () => {
  const env = seedEnv(NOW - 8 * DAY_MS);
  const res = await clipperRequest(env, '/api/clipper/submissions/1/refresh', { method: 'POST' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /tracking window has closed/i);
});

test('single-clip refresh still works for a clip inside its 7-day window', async () => {
  const env = seedEnv(NOW - 6 * DAY_MS);
  const res = await clipperRequest(env, '/api/clipper/submissions/1/refresh', { method: 'POST' });
  // Reaches the real sync attempt (no adapter configured here, so it may
  // fail downstream) -- the point is it's NOT rejected by the age guard.
  const body = await res.json();
  assert.doesNotMatch(String(body.error || ''), /tracking window has closed/i);
});
