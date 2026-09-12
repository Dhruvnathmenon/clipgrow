// The 2026-09-13 outage: every visitor saw "Internal server error" site-wide.
// Root cause was D1's free-tier daily row-read quota, exhausted because
// /api/public/campaigns -- hit by every anonymous marketing-homepage visitor,
// no session cookie needed -- ran a fresh per-campaign SUM(views) scan on
// every single hit with zero caching. /api/public/stats already caches for
// exactly this reason; this pins that the campaigns endpoint now does too,
// for an anonymous caller, while a logged-in caller (who needs the live
// number, e.g. deciding which campaign to join) still gets a fresh read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handlePublic } from '../src/routes/public.js';
import { createSessionCookie } from '../src/auth.js';

const NOW = Date.now();
const SESSION_SECRET = 'test-secret';

function seedEnv() {
  const db = makeSqliteD1({
    campaigns: [{ id: 1, name: 'T', description: '', cpm: 50, budget: 10000, status: 'active',
                  created_at: NOW, min_views: 100, allowed_platforms: 'instagram' }]
  });
  return { DB: db, SESSION_SECRET };
}

async function publicRequest(env, path, { cookie } = {}) {
  const request = new Request(`https://clipgrow.in${path}`, { headers: cookie ? { Cookie: cookie } : {} });
  return handlePublic(request, env, new URL(request.url));
}

test('an anonymous /api/public/campaigns hit is cached at the edge for an hour', async () => {
  const env = seedEnv();
  const res = await publicRequest(env, '/api/public/campaigns');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=3600');
});

test('a logged-in caller still gets a live, uncached read', async () => {
  const env = seedEnv();
  const cookie = (await createSessionCookie('clipper', 1, SESSION_SECRET)).split(';')[0];
  const res = await publicRequest(env, '/api/public/campaigns', { cookie });
  assert.equal(res.status, 200);
  assert.notEqual(res.headers.get('Cache-Control'), 'public, max-age=3600', 'a signed-in visitor needs the real number, not an hour-stale one');
});
