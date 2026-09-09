// A real production bug, caught by looking at actual data: a clipper pasted
// a link, the clip's view count landed correctly (syncAccountClips), but
// `earning` sat frozen at its insert-time 0 forever -- because computing
// earning is a SEPARATE step (allocateCampaignEarnings, which walks the
// whole campaign's FCFS budget queue) that only the single-clip REFRESH
// endpoint (POST /api/clipper/submissions/:id/refresh) was calling. This
// endpoint -- POST /api/clipper/submissions, the "paste a link" ADD path --
// does the exact same "sync one clip, read back earning" shape and had
// simply never been given the matching reallocateCampaign call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleClipper } from '../src/routes/clipper.js';
import { createSessionCookie } from '../src/auth.js';

const NOW = Date.now();
const SESSION_SECRET = 'test-secret';
const IG_USER_ID = 'ig-user-1';
const MEDIA_ID = 'media-123';
const PERMALINK = 'https://www.instagram.com/reel/abc123/';

function seedEnv() {
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'clipper1', password_hash: 'h', password_salt: 's',
                 status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'Test Campaign', description: '', cpm: 50, budget: 10000,
                  status: 'active', created_at: NOW, model: 'cpm', min_views: 100,
                  allowed_platforms: 'instagram' }],
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW }],
    social_accounts: [{ id: 1, clipper_id: 1, platform: 'instagram', username: 'ig1',
                        external_id: IG_USER_ID, status: 'connected', access_token: 'tok',
                        auto_import: 1, connected_at: NOW }],
    participation_accounts: [{ participation_id: 1, account_id: 1, platform: 'instagram', linked_at: NOW }]
  });
  return { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass', IG_CLIENT_ID: 'x', IG_CLIENT_SECRET: 'y' };
}

async function clipperRequest(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('clipper', 1, env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method, headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleClipper(request, env, new URL(request.url));
}

/** Stubs the two real Instagram Graph calls this endpoint makes: the
 * media listing (findByUrl) and the insights lookup (fetchMediaViews). */
function installFetchStub({ mediaId, permalink, views }) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes(`/${IG_USER_ID}/media`)) {
      return new Response(JSON.stringify({
        data: [{
          id: mediaId, permalink, media_type: 'VIDEO', media_product_type: 'REELS',
          timestamp: '2026-09-08T00:00:00+0000', thumbnail_url: null, media_url: null
        }]
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

test('pasting a link recomputes earning immediately, not just views', async () => {
  const env = seedEnv();
  const restore = installFetchStub({ mediaId: MEDIA_ID, permalink: PERMALINK, views: 1000 });
  try {
    const res = await clipperRequest(env, '/api/clipper/submissions', {
      method: 'POST', body: { campaign_id: 1, url: PERMALINK, platform: 'instagram' }
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.views, 1000);
    // floor(1000 * 50 / 1000) = 50 -- would be 0 without the fix, since
    // nothing but reallocateCampaign ever writes this column.
    assert.equal(body.earning, 50, 'the response itself must reflect the real allocation, not the insert-time 0');

    const row = await env.DB.prepare('SELECT views, earning FROM submissions WHERE ig_media_id = ?').bind(MEDIA_ID).first();
    assert.equal(row.views, 1000);
    assert.equal(row.earning, 50, 'stored earning must match too -- this is what every other screen reads');
  } finally {
    restore();
  }
});

test('a second pasted clip is correctly priced against the budget the first one already claimed', async () => {
  const env = seedEnv();
  const permalink2 = 'https://www.instagram.com/reel/def456/';
  // First clip claims floor(3000*50/1000) = 150 of the 10000 budget.
  let restore = installFetchStub({ mediaId: MEDIA_ID, permalink: PERMALINK, views: 3000 });
  await clipperRequest(env, '/api/clipper/submissions', {
    method: 'POST', body: { campaign_id: 1, url: PERMALINK, platform: 'instagram' }
  });
  restore();

  // A second, different clip from the same clipper.
  restore = installFetchStub({ mediaId: 'media-456', permalink: permalink2, views: 500 });
  const res = await clipperRequest(env, '/api/clipper/submissions', {
    method: 'POST', body: { campaign_id: 1, url: permalink2, platform: 'instagram' }
  });
  restore();
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  // floor(500*50/1000) = 25 -- plenty of budget left, so nothing clamps it;
  // the point is just that it's a real, non-zero, freshly-computed number.
  assert.equal(body.earning, 25);
});
