// Every record of a refresh failure used to be a bare count, an account-level
// code with no clip attached, or a single-slot column overwritten on the next
// run. An admin could see THAT 12 clips failed and never which ones, for whom,
// on which campaign, or why -- while the adapters were generating perfectly
// good explanations (message + fix) and throwing them away.
//
// refresh_events is the durable, attributable answer. These tests cover the
// two paths that previously recorded nothing at all: an item that THREW
// (caught, counted, reason discarded) and an import leg (countClips returns 0
// for imports, so a failed import moved no counter anywhere).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import {
  recordClipEvent, recordClipEvents, recordAccountEvent,
  classifyError, jobEvents, jobFailureSummary, pruneOldEvents
} from '../src/refresh-events.js';

const NOW = Date.now();

function seed() {
  return makeSqliteD1({
    clippers: [
      { id: 1, username: 'ravi', display_name: 'Ravi', password_hash: 'h', password_salt: 's', created_at: NOW },
      { id: 2, username: 'meera', display_name: 'Meera', password_hash: 'h', password_salt: 's', created_at: NOW }
    ],
    campaigns: [{ id: 7, name: 'Acme Launch', cpm: 40, budget: 100000, status: 'active',
                  created_at: NOW, min_views: 1000, allowed_platforms: 'instagram' }],
    social_accounts: [
      { id: 11, clipper_id: 1, platform: 'instagram', external_id: 'ig11', username: 'ravi.clips',
        account_type: 'BUSINESS', access_token: 't', status: 'connected', connected_at: NOW, auto_import: 1 },
      { id: 12, clipper_id: 2, platform: 'youtube', external_id: 'yt12', username: 'MeeraShorts',
        account_type: 'CHANNEL', access_token: 't', status: 'connected', connected_at: NOW, auto_import: 1 }
    ],
    submissions: [
      { id: 101, clipper_id: 1, campaign_id: 7, account_id: 11, platform: 'instagram',
        ig_media_id: 'm101', permalink: 'https://instagram.com/p/101', views: 900, earning: 0,
        status: 'active', created_at: NOW },
      { id: 102, clipper_id: 1, campaign_id: 7, account_id: 11, platform: 'instagram',
        ig_media_id: 'm102', permalink: 'https://instagram.com/p/102', views: 4000, earning: 160,
        status: 'active', created_at: NOW },
      { id: 201, clipper_id: 2, campaign_id: 7, account_id: 12, platform: 'youtube',
        ig_media_id: 'y201', permalink: 'https://youtube.com/shorts/201', views: 12000, earning: 480,
        status: 'active', created_at: NOW }
    ],
    refresh_jobs: [{
      id: 5, kind: 'global', clipper_id: null, triggered_by: 'cron', respect_cooldown: 1,
      status: 'running', pending_json: '[]', invocations: 1, clips_fetched: 0, clips_failed: 0,
      clips_skipped: 0, imported: 0, accounts_json: '{}', error: null,
      created_at: NOW, updated_at: NOW, finished_at: null
    }]
  });
}

test('a clip event carries the clipper, campaign and permalink without being told them', async () => {
  const db = seed();

  await recordClipEvent(db, {
    jobId: 5, submissionId: 101, accountId: 11, outcome: 'failed',
    code: 'TOKEN_EXPIRED', message: 'The connection has expired.', fix: 'Click Reconnect.'
  });

  const [e] = await jobEvents(db, 5);
  assert.equal(e.submission_id, 101);
  assert.equal(e.clipper_id, 1, 'pulled from the submission row in the same statement');
  assert.equal(e.campaign_id, 7);
  assert.equal(e.permalink, 'https://instagram.com/p/101');
  assert.equal(e.platform, 'instagram');
  assert.equal(e.kind, 'reauth', 'classified into something an admin can act on');
  assert.equal(e.message, 'The connection has expired.');
  assert.equal(e.fix, 'Click Reconnect.', 'the adapter text that used to be discarded');
});

test('a thrown item records one event per affected clip', async () => {
  // The path that recorded nothing: runChunk caught the throw, added the
  // item's clip count to clips_failed and moved on. The clips kept whatever
  // stale sync_error they had, and the reason lived only in account JSON.
  const db = seed();

  const n = await recordClipEvents(db, [101, 102], {
    jobId: 5, accountId: 11, outcome: 'failed',
    code: 'RATE_LIMITED', message: 'Instagram is rate limiting this account.',
    fix: 'It clears on its own; the next scheduled sync will pick it up.'
  });

  assert.equal(n, 2);
  const events = await jobEvents(db, 5, { outcome: 'failed' });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => e.submission_id).sort(), [101, 102]);
  assert.ok(events.every(e => e.kind === 'rate_limit'));
});

test('an import failure is recorded even though it moves no clip counter', async () => {
  // countClips() returns 0 for import items, so a failed import added nothing
  // to clips_failed and landed only in accounts_json. Its only symptom was new
  // uploads quietly not arriving.
  const db = seed();

  await recordAccountEvent(db, {
    jobId: 5,
    account: { account_id: 11, clipper_id: 1, campaign_id: 7, platform: 'instagram' },
    outcome: 'failed', leg: 'import', code: 'IMPORT_FAILED',
    message: 'Could not list new posts for this account.'
  });

  const [e] = await jobEvents(db, 5);
  assert.equal(e.leg, 'import');
  assert.equal(e.submission_id, null, 'an import failure is not about one clip');
  assert.equal(e.account_id, 11);
  assert.equal(e.clipper_id, 1);
});

test('failures group by clipper, then account, then clip', async () => {
  const db = seed();
  await recordClipEvents(db, [101, 102], {
    jobId: 5, accountId: 11, outcome: 'failed', code: 'TOKEN_EXPIRED',
    message: 'Expired.', fix: 'Reconnect.'
  });
  await recordClipEvent(db, {
    jobId: 5, submissionId: 201, accountId: 12, outcome: 'failed',
    code: 'MEDIA_NOT_FOUND', message: 'Gone.'
  });
  // A success must not appear in the failure summary.
  await recordClipEvent(db, { jobId: 5, submissionId: 102, accountId: 11, outcome: 'ok' });

  const summary = await jobFailureSummary(db, 5);
  assert.equal(summary.length, 2, 'two clippers');

  const ravi = summary.find(c => c.clipper === 'Ravi');
  assert.equal(ravi.accounts.length, 1);
  assert.equal(ravi.accounts[0].platform, 'instagram');
  assert.equal(ravi.accounts[0].clips.length, 2);
  assert.equal(ravi.accounts[0].clips[0].campaign, 'Acme Launch');
  assert.equal(ravi.accounts[0].clips[0].fix, 'Reconnect.');

  const meera = summary.find(c => c.clipper === 'Meera');
  assert.equal(meera.accounts[0].clips[0].kind, 'gone');
});

test('history survives the clip succeeding afterwards', async () => {
  // submissions.sync_error is a single slot cleared to NULL on the next
  // success, so "why did this fail yesterday" was unanswerable.
  const db = seed();
  await recordClipEvent(db, { jobId: 5, submissionId: 101, outcome: 'failed', code: 'RATE_LIMITED' });
  await recordClipEvent(db, { jobId: 5, submissionId: 101, outcome: 'ok' });

  const all = await jobEvents(db, 5);
  assert.equal(all.length, 2, 'both the failure and the later success are kept');
  assert.equal(all.filter(e => e.outcome === 'failed').length, 1);
});

test('classifyError sorts codes into actionable buckets', () => {
  assert.equal(classifyError(null, 'TOKEN_REVOKED'), 'reauth');
  assert.equal(classifyError({ needsReauth: true }, 'ANYTHING'), 'reauth', 'the adapter wins over the spelling');
  assert.equal(classifyError(null, 'RATE_LIMITED'), 'rate_limit');
  assert.equal(classifyError(null, 'QUOTA_EXCEEDED'), 'rate_limit');
  assert.equal(classifyError(null, 'MEDIA_NOT_FOUND'), 'gone');
  assert.equal(classifyError(null, 'NOT_PROFESSIONAL'), 'permission');
  assert.equal(classifyError(null, 'NETWORK_TIMEOUT'), 'network');
  assert.equal(classifyError(null, 'WHAT_IS_THIS'), 'unknown');
  assert.equal(classifyError(null, null), 'unknown');
});

test('recording never throws, whatever it is handed', async () => {
  // Logging must not be able to take down a sync. A submission that does not
  // exist simply records nothing.
  const db = seed();
  await recordClipEvent(db, { jobId: 5, submissionId: 999999, outcome: 'failed', code: 'X' });
  assert.equal((await jobEvents(db, 5)).length, 0, 'no row, and no exception');

  await recordClipEvent(db, { jobId: null, submissionId: 101, outcome: 'failed' });
  await recordClipEvents(db, null, { jobId: 5, outcome: 'failed' });
  await recordAccountEvent(db, { jobId: 5, account: null, outcome: 'failed' });
});

/* ─────────── retention: this table used to have none at all ─────────── */

test('pruneOldEvents removes only what has aged out, leaving recent rows alone', async () => {
  const db = seed();
  const DAY = 24 * 60 * 60 * 1000;
  await db.prepare(
    `INSERT INTO refresh_events (job_id, submission_id, outcome, created_at) VALUES (?, ?, ?, ?)`
  ).bind(1, 101, 'ok', Date.now() - 40 * DAY).run(); // older than the 30-day retention
  await db.prepare(
    `INSERT INTO refresh_events (job_id, submission_id, outcome, created_at) VALUES (?, ?, ?, ?)`
  ).bind(2, 101, 'ok', Date.now() - 2 * DAY).run(); // well within it

  await pruneOldEvents(db);

  const { results } = await db.prepare('SELECT job_id FROM refresh_events ORDER BY job_id').all();
  assert.deepEqual(results.map(r => r.job_id), [2], 'only the 40-day-old row should be gone');
});

test('pruneOldEvents never throws, even against a database that cannot run it', async () => {
  const brokenDb = { prepare() { throw new Error('no such table: refresh_events'); } };
  await pruneOldEvents(brokenDb); // must swallow, not propagate -- see safeRun's own reasoning
});
