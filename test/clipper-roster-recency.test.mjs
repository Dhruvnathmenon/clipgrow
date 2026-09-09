// GET /api/admin/clippers's active_recently field -- lets the admin panel
// sort someone who's gone quiet toward the bottom of the roster instead of
// leaving every clipper who ever posted mixed in at the top forever. Same
// 7-day definition (ACTIVE_WINDOW_MS) a campaign's own "active_participants"
// count already uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_SECRET = 'test-secret';

function seedEnv(subs = []) {
  const db = makeSqliteD1({
    clippers: [
      { id: 1, username: 'recent', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW },
      { id: 2, username: 'quiet', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW },
      { id: 3, username: 'never', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }
    ],
    campaigns: [{ id: 1, name: 'C', cpm: 40, budget: 10000, status: 'active', created_at: NOW,
                  model: 'cpm', min_views: 1000, allowed_platforms: 'instagram' }],
    submissions: subs
  });
  return { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
}

async function adminRequest(env, path) {
  const cookie = await createSessionCookie('admin', 'admin', env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, { headers: { Cookie: cookie.split(';')[0] } });
  return handleAdmin(request, env, new URL(request.url));
}

test('a clipper with a recent post is active_recently; one gone quiet is not; one who never posted is not', async () => {
  const env = seedEnv([
    { id: 1, clipper_id: 1, campaign_id: 1, platform: 'instagram', ig_media_id: 'm1', permalink: 'https://x/1',
      views: 100, earning: 0, status: 'active', created_at: NOW - 2 * DAY_MS, posted_at: NOW - 2 * DAY_MS },
    { id: 2, clipper_id: 2, campaign_id: 1, platform: 'instagram', ig_media_id: 'm2', permalink: 'https://x/2',
      views: 100, earning: 0, status: 'active', created_at: NOW - 30 * DAY_MS, posted_at: NOW - 30 * DAY_MS }
  ]);
  const { clippers } = await adminRequest(env, '/api/admin/clippers').then(r => r.json());
  const byId = Object.fromEntries(clippers.map(c => [c.id, c]));
  assert.equal(byId[1].active_recently, true, 'posted 2 days ago -- within the 7-day window');
  assert.equal(byId[2].active_recently, false, 'posted 30 days ago -- outside the window');
  assert.equal(byId[3].active_recently, false, 'never posted at all');
});

test('a disqualified or paused clip does not count toward active_recently', async () => {
  const env = seedEnv([
    { id: 1, clipper_id: 1, campaign_id: 1, platform: 'instagram', ig_media_id: 'm1', permalink: 'https://x/1',
      views: 100, earning: 0, status: 'disqualified', created_at: NOW - 1 * DAY_MS, posted_at: NOW - 1 * DAY_MS }
  ]);
  const { clippers } = await adminRequest(env, '/api/admin/clippers').then(r => r.json());
  const mine = clippers.find(c => c.id === 1);
  assert.equal(mine.active_recently, false, 'only a real active clip counts, same as a campaign\'s own active_participants');
});
