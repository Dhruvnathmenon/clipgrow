// The one write a brand can make: report a clip on their own campaign. It
// raises an admin alert and does not touch the clip. Everything else in the
// client portal stays strictly read-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleClient } from '../src/routes/client.js';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';

const NOW = Date.now();
const SECRET = 'test-secret';

async function clientReq(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('client', 1, SECRET);
  const req = new Request(`https://clipgrow.in${path}`, {
    method, headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleClient(req, env, new URL(req.url));
}
async function adminReq(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('admin', 'admin', SECRET);
  const req = new Request(`https://clipgrow.in${path}`, {
    method, headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleAdmin(req, env, new URL(req.url));
}

function seedEnv() {
  const db = makeSqliteD1({
    clients: [
      { id: 1, username: 'brand', password_hash: 'h', password_salt: 's', status: 'active',
        company_name: 'Brand Co', created_at: NOW },
      { id: 2, username: 'other', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }
    ],
    clippers: [{ id: 1, username: 'c1', password_hash: 'h', password_salt: 's', status: 'active',
                 display_name: 'Clipper One', created_at: NOW }],
    campaigns: [
      { id: 1, name: 'Mine', description: '', cpm: 50, budget: 5000, status: 'active',
        created_at: NOW, model: 'cpm', min_views: 100, allowed_platforms: 'instagram' },
      { id: 2, name: 'NotMine', description: '', cpm: 50, budget: 5000, status: 'active',
        created_at: NOW, model: 'cpm', min_views: 100, allowed_platforms: 'instagram' }
    ],
    client_campaigns: [{ client_id: 1, campaign_id: 1, granted_at: NOW }],
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW }],
    submissions: [
      { id: 10, clipper_id: 1, campaign_id: 1, platform: 'instagram', ig_media_id: 'm10',
        permalink: 'https://instagram.com/p/10', views: 20000, earning: 1000, status: 'active',
        created_at: NOW - 1000, last_ok_sync_at: NOW - 500 },
      { id: 20, clipper_id: 1, campaign_id: 2, platform: 'instagram', ig_media_id: 'm20',
        permalink: 'https://instagram.com/p/20', views: 5000, earning: 0, status: 'active',
        created_at: NOW - 1000, last_ok_sync_at: NOW - 500 }
    ]
  });
  return { DB: db, SESSION_SECRET: SECRET, ADMIN_PASSWORD: 'x' };
}

test('a brand can flag a clip on its own campaign', async () => {
  const env = seedEnv();
  const res = await clientReq(env, '/api/client/campaigns/1/clips/10/flag',
    { method: 'POST', body: { note: 'off-brand music' } });
  assert.equal(res.status, 200);

  const flags = env.DB._rows('client_clip_flags');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].submission_id, 10);
  assert.equal(flags[0].client_id, 1);
  assert.equal(flags[0].status, 'open');
  assert.equal(flags[0].note, 'off-brand music');

  // The clip itself is untouched.
  assert.equal(env.DB._rows('submissions').find(r => r.id === 10).status, 'active');
});

test('flagging twice is idempotent -- no duplicate row', async () => {
  const env = seedEnv();
  await clientReq(env, '/api/client/campaigns/1/clips/10/flag', { method: 'POST', body: {} });
  await clientReq(env, '/api/client/campaigns/1/clips/10/flag', { method: 'POST', body: {} });
  assert.equal(env.DB._rows('client_clip_flags').length, 1);
});

test('a brand cannot flag a clip on a campaign it was not granted', async () => {
  const env = seedEnv();
  const res = await clientReq(env, '/api/client/campaigns/2/clips/20/flag', { method: 'POST', body: {} });
  assert.equal(res.status, 404);
  assert.equal(env.DB._rows('client_clip_flags').length, 0);
});

test('a brand cannot flag a clip that is not on the named campaign', async () => {
  const env = seedEnv();
  const res = await clientReq(env, '/api/client/campaigns/1/clips/20/flag', { method: 'POST', body: {} });
  assert.equal(res.status, 404);
});

test('every other client mutation is still refused -- read-only holds', async () => {
  const env = seedEnv();
  for (const p of ['/api/client/me', '/api/client/campaigns/1', '/api/client/campaigns/1/clips/10/unflag']) {
    const res = await clientReq(env, p, { method: 'POST', body: {} });
    assert.equal(res.status, 405, p + ' must stay read-only');
  }
});

test('the flag shows on the admin Overview and clears when the clip is invalidated', async () => {
  const env = seedEnv();
  await clientReq(env, '/api/client/campaigns/1/clips/10/flag', { method: 'POST', body: { note: 'fake views' } });

  let ov = await (await adminReq(env, '/api/admin/overview')).json();
  assert.equal(ov.client_flags.length, 1);
  assert.equal(ov.client_flags[0].client_name, 'Brand Co');
  assert.equal(ov.client_flags[0].clipper_name, 'Clipper One');

  await adminReq(env, '/api/admin/submissions/10/invalidate', { method: 'POST', body: { reason: 'confirmed botting' } });

  ov = await (await adminReq(env, '/api/admin/overview')).json();
  assert.equal(ov.client_flags.length, 0, 'invalidating the clip closes its flag');
  assert.equal(env.DB._rows('client_clip_flags')[0].status, 'actioned');
});

test('admin can dismiss a flag as a false alarm', async () => {
  const env = seedEnv();
  await clientReq(env, '/api/client/campaigns/1/clips/10/flag', { method: 'POST', body: {} });
  const id = env.DB._rows('client_clip_flags')[0].id;

  const res = await adminReq(env, `/api/admin/client-flags/${id}/dismiss`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(env.DB._rows('client_clip_flags')[0].status, 'dismissed');

  const ov = await (await adminReq(env, '/api/admin/overview')).json();
  assert.equal(ov.client_flags.length, 0);
});

test('invalidated clips vanish from the client campaign view and their flag state shows while open', async () => {
  const env = seedEnv();
  await clientReq(env, '/api/client/campaigns/1/clips/10/flag', { method: 'POST', body: {} });

  let detail = await (await clientReq(env, '/api/client/campaigns/1')).json();
  assert.equal(detail.clips.length, 1);
  assert.equal(detail.clips[0].flagged, true, 'brand sees its own open report');

  await adminReq(env, '/api/admin/submissions/10/invalidate', { method: 'POST', body: { reason: 'x' } });

  detail = await (await clientReq(env, '/api/client/campaigns/1')).json();
  assert.equal(detail.clips.length, 0, 'a flagged-invalid clip is gone from the brand view entirely');
  assert.equal(detail.totals.views, 0, 'and its views leave the totals');
});
