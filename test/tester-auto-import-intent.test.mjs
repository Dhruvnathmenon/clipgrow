// Pre-plans the auto-import choice at approval time (migration 016) instead
// of making the admin wait for a clipper to connect and then remember to
// flip the per-account "Switch to paste-only" toggle afterward -- for
// someone approved specifically because they'll post campaign work on a
// shared/main account that also carries unrelated videos.
//
// migration 016 added tester_requests.auto_import, but migration 025 (a
// later, unrelated table rebuild to fix a UNIQUE constraint) silently
// dropped it again -- nothing ever read or wrote the column, so nothing
// noticed until this feature actually tried to. migration 036 restores it.
// This file is the first real exercise of any of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { approvedAutoImportIntent } from '../src/db.js';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';

const NOW = Date.now();
const SESSION_SECRET = 'test-secret';

function seedEnv({ requests = [], accounts = [], links = [] } = {}) {
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'clipper1', password_hash: 'h', password_salt: 's',
                 status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'T', cpm: 40, budget: 100000, status: 'active',
                  created_at: NOW, min_views: 1000, allowed_platforms: 'instagram,youtube' }],
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW }],
    tester_requests: requests,
    social_accounts: accounts,
    participation_accounts: links
  });
  return { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
}

async function adminRequest(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('admin', 'admin', env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method, headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleAdmin(request, env, new URL(request.url));
}

const request = (o = {}) => ({
  id: 1, clipper_id: 1, campaign_id: 1, platform: 'instagram', identifier: '@handle',
  ig_username: '@handle', status: 'confirmed', requested_at: NOW, auto_import: 1, ...o
});

/* ── approvedAutoImportIntent (read at account-creation time) ── */

test('reads the confirmed request\'s auto_import intent', async () => {
  const env = seedEnv({ requests: [request({ auto_import: 0 })] });
  assert.equal(await approvedAutoImportIntent(env.DB, 1, 1, 'instagram'), 0);
});

test('defaults to 1 (automatic) when there is no confirmed request to read', async () => {
  const env = seedEnv({ requests: [request({ status: 'requested', auto_import: 0 })] });
  assert.equal(await approvedAutoImportIntent(env.DB, 1, 1, 'instagram'), 1, 'not confirmed yet -- intent has no effect');
});

test('is scoped to the right campaign and platform, not just the clipper', async () => {
  const env = seedEnv({ requests: [request({ auto_import: 0, campaign_id: 1, platform: 'instagram' })] });
  assert.equal(await approvedAutoImportIntent(env.DB, 1, 2, 'instagram'), 1, 'different campaign');
  assert.equal(await approvedAutoImportIntent(env.DB, 1, 1, 'youtube'), 1, 'different platform');
});

/* ── PATCH /api/admin/access-requests/:id -- setting the intent ── */

test('the admin can pre-plan paste-only before the clipper has connected anything', async () => {
  const env = seedEnv({ requests: [request()] });
  const res = await adminRequest(env, '/api/admin/access-requests/1', {
    method: 'PATCH', body: { auto_import: false }
  });
  assert.equal(res.status, 200);
  const row = await env.DB.prepare('SELECT auto_import FROM tester_requests WHERE id = 1').first();
  assert.equal(row.auto_import, 0);
});

test('setting the intent does not require also touching status', async () => {
  const env = seedEnv({ requests: [request({ status: 'requested' })] });
  const res = await adminRequest(env, '/api/admin/access-requests/1', {
    method: 'PATCH', body: { auto_import: false }
  });
  assert.equal(res.status, 200);
  const row = await env.DB.prepare('SELECT status, auto_import FROM tester_requests WHERE id = 1').first();
  assert.equal(row.status, 'requested', 'unrelated field left alone');
  assert.equal(row.auto_import, 0);
});

test('toggling the intent for an ALREADY-CONNECTED clipper updates their real account immediately too', async () => {
  // This is the "both need to be doing the same action" requirement: the
  // pre-plan toggle and the Connected Accounts table's per-account toggle
  // must never disagree just because of when each was flipped.
  const env = seedEnv({
    requests: [request({ auto_import: 1 })],
    accounts: [{ id: 10, clipper_id: 1, platform: 'instagram', external_id: 'ig10', username: 'h',
                 access_token: 't', status: 'connected', connected_at: NOW, auto_import: 1 }],
    links: [{ id: 1, participation_id: 1, account_id: 10, platform: 'instagram', linked_at: NOW }]
  });
  const res = await adminRequest(env, '/api/admin/access-requests/1', {
    method: 'PATCH', body: { auto_import: false }
  });
  assert.equal(res.status, 200);
  const account = await env.DB.prepare('SELECT auto_import FROM social_accounts WHERE id = 10').first();
  assert.equal(account.auto_import, 0, 'the real, already-connected account switched to paste-only too');
});

test('toggling back to automatic for a connected clipper also updates the real account', async () => {
  const env = seedEnv({
    requests: [request({ auto_import: 0 })],
    accounts: [{ id: 10, clipper_id: 1, platform: 'instagram', external_id: 'ig10', username: 'h',
                 access_token: 't', status: 'connected', connected_at: NOW, auto_import: 0 }],
    links: [{ id: 1, participation_id: 1, account_id: 10, platform: 'instagram', linked_at: NOW }]
  });
  await adminRequest(env, '/api/admin/access-requests/1', { method: 'PATCH', body: { auto_import: true } });
  const account = await env.DB.prepare('SELECT auto_import FROM social_accounts WHERE id = 10').first();
  assert.equal(account.auto_import, 1);
});

test('a request with no connected account yet is unaffected beyond its own row', async () => {
  const env = seedEnv({ requests: [request()] });
  const res = await adminRequest(env, '/api/admin/access-requests/1', {
    method: 'PATCH', body: { auto_import: false }
  });
  assert.equal(res.status, 200); // no social_accounts row to touch -- must not error
});

test('omitting auto_import from a status-only PATCH leaves the existing intent untouched', async () => {
  const env = seedEnv({ requests: [request({ status: 'requested', auto_import: 0 })] });
  await adminRequest(env, '/api/admin/access-requests/1', { method: 'PATCH', body: { status: 'confirmed' } });
  const row = await env.DB.prepare('SELECT status, auto_import FROM tester_requests WHERE id = 1').first();
  assert.equal(row.status, 'confirmed');
  assert.equal(row.auto_import, 0, 'not reset to the default just because this PATCH was about something else');
});

test('GET /api/admin/access-requests exposes auto_import so the admin panel can render the toggle', async () => {
  const env = seedEnv({ requests: [request({ auto_import: 0 })] });
  const { requests: rows } = await (await adminRequest(env, '/api/admin/access-requests')).json();
  assert.equal(rows[0].auto_import, 0);
});
