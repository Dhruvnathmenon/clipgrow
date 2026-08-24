// Auto-import silently stopped creating clips for about 28 hours in production.
// The chained-refresh refactor replaced autoImportClips() with runImport(),
// which fetched the media, counted it, and returned the count -- without ever
// inserting a row. Nothing failed. The refresh panel still reported "N new
// videos found" from the array it discarded, and the campaign page still told
// clippers "new Reels are added automatically".
//
// The existing auto-import test could not catch it: it exercises listRecent(),
// the part that still worked, and never asserts that a row lands in the table.
// These tests assert the row.
//
// Runs against real SQLite with the real schema, so the INSERT is checked for
// column and constraint correctness too, not just for having been attempted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { runChunk, createRefreshJob, advanceJob } from '../src/refresh-jobs.js';

const NOW = Date.now();

function seeded({ allowed = 'instagram', autoImport = 1 } = {}) {
  return makeSqliteD1({
    clippers: [{ id: 1, username: 'c1', password_hash: 'h', password_salt: 's', created_at: NOW }],
    campaigns: [{ id: 1, name: 'Camp', cpm: 40, budget: 100000, status: 'active',
                  created_at: NOW, min_views: 1000, allowed_platforms: allowed }],
    social_accounts: [{ id: 10, clipper_id: 1, platform: 'instagram', external_id: 'ig1',
                        username: 'handle', account_type: 'BUSINESS', access_token: 'tok',
                        status: 'connected', connected_at: NOW - 86400000, auto_import: autoImport }],
    participations: [{ id: 100, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW, account_id: 10 }],
    participation_accounts: [{ id: 1000, participation_id: 100, account_id: 10, platform: 'instagram', linked_at: NOW }]
  });
}

// Two fresh posts the clipper has just published.
const MEDIA = [
  { external_id: 'm1', permalink: 'https://instagram.com/reel/m1', media_type: 'REELS',
    thumbnail_url: null, posted_at: NOW - 1000, duration_seconds: 20, is_short: null },
  { external_id: 'm2', permalink: 'https://instagram.com/reel/m2', media_type: 'REELS',
    thumbnail_url: null, posted_at: NOW - 500, duration_seconds: 25, is_short: null }
];

const adapters = (media = MEDIA) => ({
  instagram: {
    listRecent: async () => media,
    fetchViews: async (_a, ids) => new Map(ids.map(id => [id, { ok: true, views: 0 }]))
  }
});

async function runImportLeg(db, { media = MEDIA } = {}) {
  const created = await createRefreshJob(db, { kind: 'global', triggeredBy: 'test', respectCooldown: false });
  assert.ok(created.job_id, created.error || 'job should be created');
  // Drive legs until the job finishes, so the import item actually executes.
  for (let i = 0; i < 10; i++) {
    const r = await runChunk(db, {}, created.job_id, { adapters: adapters(media) });
    if (r && r.done) break;
  }
  return created.job_id;
}

test('a newly posted video is actually written to submissions, not just counted', async () => {
  const db = seeded();
  await runImportLeg(db);

  const rows = db._rows('submissions');
  assert.equal(rows.length, 2, 'both fetched videos must exist as clips');
  const byMedia = Object.fromEntries(rows.map(r => [r.ig_media_id, r]));
  assert.ok(byMedia.m1 && byMedia.m2, 'both media ids must be present');
  assert.equal(byMedia.m1.source, 'auto');
  assert.equal(byMedia.m1.clipper_id, 1);
  assert.equal(byMedia.m1.campaign_id, 1);
  assert.equal(byMedia.m1.account_id, 10);
  assert.equal(byMedia.m1.status, 'active');
  assert.equal(byMedia.m1.permalink, 'https://instagram.com/reel/m1');
});

test('running the import twice does not duplicate a clip', async () => {
  const db = seeded();
  await runImportLeg(db);
  await runImportLeg(db);
  assert.equal(db._rows('submissions').length, 2, 'second run must find them already known');
});

test('a paste-only account imports nothing automatically', async () => {
  // auto_import = 0 is for a clipper posting unrelated personal videos from the
  // same account; sweeping those in would put them in a brand's campaign.
  const db = seeded({ autoImport: 0 });
  await runImportLeg(db);
  assert.equal(db._rows('submissions').length, 0);
});

test('a clip never lands on a platform the campaign does not accept', async () => {
  const db = seeded({ allowed: 'youtube' });   // Instagram account, YouTube-only campaign
  await runImportLeg(db);
  assert.equal(db._rows('submissions').length, 0);
});

test('a paused clipper keeps tracking views but gains no new clips', async () => {
  // The campaign page promises paused clips "keep tracking and earning", and the
  // allocator does keep pricing them -- so excluding them from refresh froze
  // their views while they carried on earning against a number that could never
  // move. They refresh; only the import leg is withheld.
  const db = seeded();
  db._sqlite.prepare("UPDATE participations SET status = 'paused' WHERE id = 100").run();

  // An existing clip, already tracked, should still be refreshed.
  db._sqlite.prepare(
    `INSERT INTO submissions (clipper_id, campaign_id, account_id, platform, ig_media_id,
       permalink, views, earning, status, created_at, source, eligible)
     VALUES (1, 1, 10, 'instagram', 'old1', 'https://x/old1', 100, 0, 'active', ?, 'auto', 1)`
  ).run(NOW - 7200000);

  await runImportLeg(db);

  const rows = db._rows('submissions');
  assert.equal(rows.length, 1, 'no NEW clip may be imported while paused');
  assert.equal(rows[0].ig_media_id, 'old1');
  assert.ok(rows[0].last_ok_sync_at, 'the existing clip must still have been refreshed');
});
