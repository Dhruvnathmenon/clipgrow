// Proves the engine actually WRITES the history, not just that the recorder
// can. The other refresh tests drive a hand-written fake DB that throws on any
// SQL it does not recognise -- and recordClipEvent swallows its own errors on
// purpose (logging must never break a sync), so those tests would pass whether
// events were being written or silently dropped.
//
// This one runs runChunk against real SQLite with the real schema, so an event
// either lands in the table or the assertion fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { runChunk, buildAccountItems, createRefreshJob } from '../src/refresh-jobs.js';

const NOW = Date.now();

/** A full participation chain: clipper -> campaign -> account -> clips. */
function seed(clipSpecs) {
  return makeSqliteD1({
    clippers: [{ id: 1, username: 'ravi', display_name: 'Ravi',
                 password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }],
    campaigns: [{ id: 7, name: 'Acme Launch', cpm: 40, budget: 1000000, status: 'active',
                  created_at: NOW, min_views: 1000, allowed_platforms: 'instagram' }],
    social_accounts: [{ id: 11, clipper_id: 1, platform: 'instagram', external_id: 'ig11',
                        username: 'ravi.clips', account_type: 'BUSINESS', access_token: 't',
                        status: 'connected', connected_at: NOW, auto_import: 0 }],
    participations: [{ id: 3, clipper_id: 1, campaign_id: 7, status: 'active', joined_at: NOW, account_id: 11 }],
    participation_accounts: [{ id: 30, participation_id: 3, account_id: 11, platform: 'instagram', linked_at: NOW }],
    submissions: clipSpecs.map(c => ({
      id: c.id, clipper_id: 1, campaign_id: 7, account_id: 11, platform: 'instagram',
      ig_media_id: c.media, permalink: `https://instagram.com/p/${c.id}`,
      views: 1000, earning: 40, status: 'active', eligible: 1,
      created_at: NOW, posted_at: NOW
    }))
  });
}

/** Adapter that answers per media id: a number, {err}, or undefined (gone). */
function adapter(byId, { throwFor = null } = {}) {
  return {
    instagram: {
      fetchViews: async (account, ids, env, { onAttempt } = {}) => {
        if (throwFor && ids.includes(throwFor)) {
          const e = new Error('The connection to this Instagram account has expired.');
          e.code = 'TOKEN_EXPIRED';
          e.needsReauth = true;
          e.fix = 'Click Reconnect on this campaign to re-authorise the account.';
          throw e;
        }
        const map = new Map();
        for (const id of ids) {
          if (onAttempt) onAttempt();
          const v = byId[id];
          map.set(id, v === undefined ? undefined
            : (v && v.err ? { ok: false, code: v.err, message: v.message, fix: v.fix } : { ok: true, views: v }));
        }
        return map;
      },
      listRecent: async () => []
    }
  };
}

const events = (db) => db._rows('refresh_events');

test('a per-clip failure is written with its clipper, campaign, permalink and reason', async () => {
  const db = seed([{ id: 101, media: 'm101' }]);
  const { job_id } = await createRefreshJob(db, { kind: 'global', triggeredBy: 'cron', respectCooldown: false });

  await runChunk(db, {}, job_id, {
    adapters: adapter({
      m101: { err: 'NOT_PROFESSIONAL', message: 'That account is a Personal account.', fix: 'Switch to a professional account.' }
    })
  });

  const rows = events(db);
  assert.equal(rows.length, 1);
  const e = rows[0];
  assert.equal(e.outcome, 'failed');
  assert.equal(e.submission_id, 101);
  assert.equal(e.clipper_id, 1);
  assert.equal(e.campaign_id, 7);
  assert.equal(e.permalink, 'https://instagram.com/p/101');
  assert.equal(e.code, 'NOT_PROFESSIONAL');
  assert.equal(e.kind, 'permission');
  assert.equal(e.fix, 'Switch to a professional account.', 'adapter text reaches the database');
  assert.equal(e.job_id, job_id);
});

test('a successful clip is recorded too, so "what got through" is answerable', async () => {
  const db = seed([{ id: 101, media: 'm101' }]);
  const { job_id } = await createRefreshJob(db, { kind: 'global', triggeredBy: 'cron', respectCooldown: false });

  await runChunk(db, {}, job_id, { adapters: adapter({ m101: 5000 }) });

  const rows = events(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'ok');
  assert.equal(rows[0].submission_id, 101);
});

test('a deleted post is recorded as gone, not as a mystery', async () => {
  const db = seed([{ id: 101, media: 'm101' }]);
  const { job_id } = await createRefreshJob(db, { kind: 'global', triggeredBy: 'cron', respectCooldown: false });

  await runChunk(db, {}, job_id, { adapters: adapter({}) });   // undefined => not found

  const [e] = events(db);
  assert.equal(e.code, 'MEDIA_NOT_FOUND');
  assert.equal(e.kind, 'gone');
  assert.ok(e.message, 'and it explains itself');
});

test('an item that THROWS records one event per clip it was carrying', async () => {
  // The path that previously recorded nothing at all: the throw happens before
  // any per-clip write, so clips_failed went up while the clips kept whatever
  // stale sync_error they already had.
  const db = seed([{ id: 101, media: 'm101' }, { id: 102, media: 'm102' }]);
  const { job_id } = await createRefreshJob(db, { kind: 'global', triggeredBy: 'cron', respectCooldown: false });

  await runChunk(db, {}, job_id, { adapters: adapter({}, { throwFor: 'm101' }) });

  const failed = events(db).filter(e => e.outcome === 'failed');
  assert.ok(failed.length >= 1, 'the thrown item is no longer silent');
  const e = failed.find(x => x.submission_id === 101);
  assert.equal(e.code, 'TOKEN_EXPIRED');
  assert.equal(e.kind, 'reauth');
  assert.equal(e.clipper_id, 1, 'still attributable to a person');
  assert.match(e.fix, /Reconnect/);
});

test('the recorded history outlives the clip succeeding later', async () => {
  const db = seed([{ id: 101, media: 'm101' }]);

  const first = await createRefreshJob(db, { kind: 'global', triggeredBy: 'cron', respectCooldown: false });
  await runChunk(db, {}, first.job_id, { adapters: adapter({ m101: { err: 'RATE_LIMITED' } }) });

  // Second run succeeds and clears submissions.sync_error -- which is exactly
  // how the old single-slot record lost the reason.
  const second = await createRefreshJob(db, { kind: 'global', triggeredBy: 'cron', respectCooldown: false });
  await runChunk(db, {}, second.job_id, { adapters: adapter({ m101: 8000 }) });

  const clip = db._rows('submissions')[0];
  assert.equal(clip.sync_error, null, 'the live column has forgotten');

  const all = events(db);
  assert.equal(all.filter(e => e.outcome === 'failed').length, 1, 'the history has not');
  assert.equal(all.filter(e => e.outcome === 'ok').length, 1);
});

test('buildAccountItems still drives the whole chain from a real participation', async () => {
  // Guards the join the engine depends on: participation_accounts ->
  // participations -> campaigns -> social_accounts.
  const db = seed([{ id: 101, media: 'm101' }, { id: 102, media: 'm102' }]);
  const acct = {
    account_id: 11, platform: 'instagram', auto_import: 0, part_status: 'active'
  };
  const items = await buildAccountItems(db, acct, { respectCooldown: false });
  assert.equal(items.length, 2, 'one view item per clip');
  assert.deepEqual(items.map(i => i.s).sort(), [101, 102]);
});
