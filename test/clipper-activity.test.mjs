// "Joined" vs "active" clippers, on both the Overview tile and the per-
// campaign roster count. Anyone can join a campaign with one click -- that
// says nothing about whether they're actually clipping. "Active" means a
// real post (COALESCE(posted_at, created_at), never import time -- same
// reasoning as the streak in db.js) within ACTIVE_WINDOW_MS (7 days).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';
import { ACTIVE_WINDOW_MS } from '../src/db.js';

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
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

const clipper = (id, overrides = {}) => ({
  id, username: 'clipper' + id, password_hash: 'h', password_salt: 's',
  status: 'active', created_at: NOW, ...overrides
});

const campaign = (id, overrides = {}) => ({
  id, name: 'Campaign ' + id, description: '', cpm: 40, budget: 10000,
  status: 'active', created_at: NOW, model: 'cpm', min_views: 1000,
  allowed_platforms: 'instagram', ...overrides
});

const part = (id, clipperId, campaignId, overrides = {}) => ({
  id, clipper_id: clipperId, campaign_id: campaignId, status: 'active',
  joined_at: NOW, ...overrides
});

const sub = (id, clipperId, campaignId, overrides = {}) => ({
  id, clipper_id: clipperId, campaign_id: campaignId, platform: 'instagram',
  ig_media_id: 'm' + id, permalink: 'https://instagram.com/p/' + id,
  views: 0, earning: 0, status: 'active', created_at: NOW, ...overrides
});

test('Overview: joined_clippers counts every enabled clipper, active_clippers only those who posted recently', async () => {
  const db = makeSqliteD1({
    clippers: [
      clipper(1), // posted recently -> active
      clipper(2), // never posted -> joined only
      clipper(3, { status: 'disabled' }) // disabled -> counted in neither
    ],
    campaigns: [campaign(1)],
    participations: [part(1, 1, 1), part(2, 2, 1)],
    submissions: [sub(1, 1, 1, { posted_at: NOW - DAY_MS })]
  });
  const env = { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
  const res = await adminRequest(env, '/api/admin/overview');
  const { overview } = await res.json();
  assert.equal(overview.joined_clippers, 2, 'the disabled clipper is excluded, same as before this change');
  assert.equal(overview.active_clippers, 1, 'only clipper 1 posted recently');
});

test('Overview: total_views sums every clip regardless of status, campaign, or age', async () => {
  const db = makeSqliteD1({
    clippers: [clipper(1)],
    campaigns: [campaign(1), campaign(2)],
    participations: [part(1, 1, 1), part(2, 1, 2)],
    submissions: [
      sub(1, 1, 1, { views: 1200, status: 'active' }),
      sub(2, 1, 1, { views: 300, status: 'disqualified' }),
      sub(3, 1, 2, { views: 4500, created_at: NOW - 30 * DAY_MS })
    ]
  });
  const env = { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
  const { overview } = await (await adminRequest(env, '/api/admin/overview')).json();
  assert.equal(overview.total_views, 1200 + 300 + 4500, 'the whole-history number, no status or age filter');
});

test('Overview: a post older than the active window does not count as active', async () => {
  const db = makeSqliteD1({
    clippers: [clipper(1)],
    campaigns: [campaign(1)],
    participations: [part(1, 1, 1)],
    submissions: [sub(1, 1, 1, { posted_at: NOW - (ACTIVE_WINDOW_MS + DAY_MS) })]
  });
  const env = { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
  const { overview } = await (await adminRequest(env, '/api/admin/overview')).json();
  assert.equal(overview.joined_clippers, 1);
  assert.equal(overview.active_clippers, 0, 'stale post -- joined, not active');
});

test('Overview: a clipper active across two campaigns is counted once, not twice', async () => {
  const db = makeSqliteD1({
    clippers: [clipper(1)],
    campaigns: [campaign(1), campaign(2)],
    participations: [part(1, 1, 1), part(2, 1, 2)],
    submissions: [
      sub(1, 1, 1, { posted_at: NOW - DAY_MS }),
      sub(2, 1, 2, { posted_at: NOW - DAY_MS })
    ]
  });
  const env = { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
  const { overview } = await (await adminRequest(env, '/api/admin/overview')).json();
  assert.equal(overview.active_clippers, 1, 'one real person, counted once in the global total');
});

test('Campaigns list: participants (joined) vs active_participants (posted recently on THIS campaign)', async () => {
  const db = makeSqliteD1({
    clippers: [clipper(1), clipper(2)],
    campaigns: [campaign(1)],
    // clipper 1 joined and posted recently; clipper 2 joined but never posted.
    participations: [part(1, 1, 1), part(2, 2, 1)],
    submissions: [sub(1, 1, 1, { posted_at: NOW - DAY_MS })]
  });
  const env = { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
  const { campaigns } = await (await adminRequest(env, '/api/admin/campaigns')).json();
  const c = campaigns.find(x => x.id === 1);
  assert.equal(c.participants, 2, 'both joined');
  assert.equal(c.active_participants, 1, 'only one of them has actually posted recently');
});

test('Campaigns list: a clipper active on campaign A does not count as active on unrelated campaign B', async () => {
  const db = makeSqliteD1({
    clippers: [clipper(1)],
    campaigns: [campaign(1), campaign(2)],
    participations: [part(1, 1, 1), part(2, 1, 2)],
    // Posted on campaign 1 only.
    submissions: [sub(1, 1, 1, { posted_at: NOW - DAY_MS })]
  });
  const env = { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
  const { campaigns } = await (await adminRequest(env, '/api/admin/campaigns')).json();
  assert.equal(campaigns.find(x => x.id === 1).active_participants, 1);
  assert.equal(campaigns.find(x => x.id === 2).active_participants, 0, 'joined campaign 2 but never posted there');
});

test('Campaigns list: a kicked participant with a recent post does not count as joined or active', async () => {
  const db = makeSqliteD1({
    clippers: [clipper(1)],
    campaigns: [campaign(1)],
    participations: [part(1, 1, 1, { status: 'kicked' })],
    submissions: [sub(1, 1, 1, { posted_at: NOW - DAY_MS })]
  });
  const env = { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
  const { campaigns } = await (await adminRequest(env, '/api/admin/campaigns')).json();
  const c = campaigns.find(x => x.id === 1);
  assert.equal(c.participants, 0, 'kicked -- not counted as joined either, matching the existing rule');
  assert.equal(c.active_participants, 0, 'no longer part of this campaign\'s roster at all');
});
