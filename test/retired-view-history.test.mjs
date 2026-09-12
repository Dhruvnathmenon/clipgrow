// "Total views generated" is shown off publicly (tracker.html, the marketing
// Story page, admin.html's hero stat, and each clipper's own dashboard/the
// leaderboard) as a lifetime "look how much we've done" figure. A plain
// SUM(views) FROM submissions quietly shrinks it the moment a row is
// deleted -- an account disconnect freeing an unpaid clip (a real production
// case: disconnecting one of Rexon's accounts dropped the site-wide total),
// or a manual admin delete. retired_view_history (migration 041) is where a
// deleted row's views land instead of nowhere; these tests prove every
// surface that advertises a lifetime total actually adds it back in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { disconnectSocialAccount, clipperTotals } from '../src/db.js';
import { handleAdmin } from '../src/routes/admin.js';
import { handlePublic } from '../src/routes/public.js';
import { handleClipper } from '../src/routes/clipper.js';
import { createSessionCookie } from '../src/auth.js';

const NOW = Date.now();
const SESSION_SECRET = 'test-secret';

async function adminRequest(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('admin', 'admin', env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method, headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleAdmin(request, env, new URL(request.url));
}
async function clipperRequest(env, path, clipperId = 1) {
  const cookie = await createSessionCookie('clipper', clipperId, env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, { headers: { Cookie: cookie.split(';')[0] } });
  return handleClipper(request, env, new URL(request.url));
}
async function publicRequest(env, path, clipperId = 1) {
  const cookie = await createSessionCookie('clipper', clipperId, env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, { headers: { Cookie: cookie.split(';')[0] } });
  return handlePublic(request, env, new URL(request.url));
}

function seed({ submissions, clippers } = {}) {
  const db = makeSqliteD1({
    clippers: clippers || [{ id: 1, username: 'rexon', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'T', cpm: 50, budget: 100000, status: 'active', created_at: NOW, min_views: 100, allowed_platforms: 'instagram' }],
    social_accounts: [{ id: 1, clipper_id: 1, platform: 'instagram', username: 'ig1', external_id: 'e1', status: 'connected', access_token: 'tok', auto_import: 0, connected_at: NOW }],
    submissions: submissions || []
  });
  return { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
}

const sub = (id, o = {}) => ({
  id, clipper_id: 1, campaign_id: 1, account_id: 1, platform: 'instagram', ig_media_id: 'm' + id,
  permalink: 'p' + id, views: 0, earning: 0, status: 'active', eligible: 1, created_at: NOW, ...o
});

test('disconnecting an account never drops the admin Overview\'s lifetime total_views', async () => {
  const env = seed({ submissions: [sub(1, { views: 4000 }), sub(2, { views: 1000, locked_at: NOW - 1000 })] });
  const before = await adminRequest(env, '/api/admin/overview').then(r => r.json());
  assert.equal(before.overview.total_views, 5000);

  await disconnectSocialAccount(env.DB, 1);   // deletes the unlocked clip (4000 views)

  const after = await adminRequest(env, '/api/admin/overview').then(r => r.json());
  assert.equal(after.overview.total_views, 5000, 'the 4000 retired views must still be counted, not erased');
});

test('a manual admin clip delete retires that clip\'s views the same way', async () => {
  const env = seed({ submissions: [sub(1, { views: 750 })] });
  const before = await adminRequest(env, '/api/admin/overview').then(r => r.json());
  assert.equal(before.overview.total_views, 750);

  const del = await adminRequest(env, '/api/admin/submissions/1', { method: 'DELETE' });
  assert.equal(del.status, 200);

  const after = await adminRequest(env, '/api/admin/overview').then(r => r.json());
  assert.equal(after.overview.total_views, 750, 'deleted-but-real views must survive in the lifetime total');
  const retired = await env.DB.prepare('SELECT * FROM retired_view_history').first();
  assert.equal(retired.reason, 'admin_delete');
  assert.equal(retired.views, 750);
});

test('a manual admin delete of a clip with zero views writes no retired_view_history row', async () => {
  const env = seed({ submissions: [sub(1, { views: 0 })] });
  const del = await adminRequest(env, '/api/admin/submissions/1', { method: 'DELETE' });
  assert.equal(del.status, 200);
  const rows = await env.DB.prepare('SELECT * FROM retired_view_history').all();
  assert.equal(rows.results.length, 0);
});

test('the public /api/public/stats lifetime total also survives a disconnect, and counts a paused/disqualified clip too', async () => {
  const env = seed({
    submissions: [
      sub(1, { views: 2000 }),                                  // will be disconnected away
      sub(2, { views: 300, status: 'paused' }),                 // still counts -- it really happened
      sub(3, { views: 150, status: 'disqualified' })            // still counts -- same reasoning
    ]
  });
  const before = await publicRequest(env, '/api/public/stats').then(r => r.json());
  assert.equal(before.total_views, 2450, 'a lifetime figure counts every clip that ever tracked views, not just active ones');

  await disconnectSocialAccount(env.DB, 1);

  const after = await publicRequest(env, '/api/public/stats').then(r => r.json());
  assert.equal(after.total_views, 2450, 'must not drop after the disconnect');
});

test('the public leaderboard keeps a clipper\'s lifetime views and video_count even after every one of their clips is deleted', async () => {
  const env = seed({ submissions: [sub(1, { views: 900 })] });
  const before = await publicRequest(env, '/api/public/leaderboard').then(r => r.json());
  assert.equal(before.leaderboard[0].total_views, 900);
  assert.equal(before.leaderboard[0].video_count, 1);

  await disconnectSocialAccount(env.DB, 1);   // this clipper's only clip, now deleted entirely

  const after = await publicRequest(env, '/api/public/leaderboard').then(r => r.json());
  const row = after.leaderboard.find(r => r.id === 1);
  assert.ok(row, 'the clipper must not vanish from the board just because they have zero live rows left');
  assert.equal(row.total_views, 900, 'their historical views must still show');
  assert.equal(row.video_count, 1);
});

test('the internal clipper directory (all-clippers view) also keeps lifetime views after a disconnect', async () => {
  const env = seed({ submissions: [sub(1, { views: 500 })] });
  await disconnectSocialAccount(env.DB, 1);
  const { clippers } = await clipperRequest(env, '/api/clipper/directory').then(r => r.json());
  const me = clippers.find(c => c.id === 1);
  assert.equal(me.views, 500);
});

test('clipperTotals (a clipper\'s own dashboard header) keeps lifetime views after a disconnect, scoped to just that clipper', async () => {
  const env = seed({
    clippers: [
      { id: 1, username: 'rexon', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW },
      { id: 2, username: 'other', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }
    ],
    submissions: [sub(1, { views: 800, clipper_id: 1 }), sub(2, { views: 300, clipper_id: 2, account_id: null, ig_media_id: 'm2b' })]
  });
  await disconnectSocialAccount(env.DB, 1);

  const rexon = await clipperTotals(env.DB, 1);
  assert.equal(rexon.views, 800, 'Rexon keeps his own lifetime total');
  assert.equal(rexon.clips, 1);

  const other = await clipperTotals(env.DB, 2);
  assert.equal(other.views, 300, 'a different clipper\'s own total is untouched by someone else\'s disconnect');
});
