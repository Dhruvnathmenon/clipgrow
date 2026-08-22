// Paste-only accounts (migration 015).
//
// The case: a clipper posts campaign work from their MAIN account, which also
// carries videos that have nothing to do with any campaign. Auto-import lists
// everything the account published and cannot tell the two apart, so leaving it
// on would sweep personal videos into the campaign and pay out on them. Those
// accounts are switched to paste-only: nothing is picked up on its own, and the
// clipper submits each campaign video by link (still verified as genuinely
// theirs by findByUrl on the submit path).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoImportClips } from '../src/earnings.js';

// Minimal D1 stand-in that honours the auto_import filter the way SQLite does,
// so the test proves the real query shape rather than a JS re-implementation.
function makeDb(accounts) {
  const listed = [];
  return {
    _listed: listed,
    prepare(sql) {
      let args = [];
      const st = {
        bind: (...a) => { args = a; return st; },
        all: async () => {
          if (/FROM participation_accounts pa/.test(sql)) {
            const rows = accounts
              .filter(a => a.status === 'connected' && a.access_token)
              .filter(a => (/a\.auto_import != 0/.test(sql) ? a.auto_import !== 0 : true))
              .map(a => ({
                account_id: a.id, platform: a.platform, external_id: 'x', access_token: a.access_token,
                refresh_token: null, token_expires_at: Date.now() + 3600000, meta_json: '{}',
                connected_at: 0, status: a.status,
                clipper_id: a.clipper_id, campaign_id: 1, allowed_platforms: 'instagram,youtube'
              }));
            return { results: rows };
          }
          // known-ids preload
          return { results: [] };
        },
        first: async () => null,
        run: async () => ({ meta: {} })
      };
      return st;
    },
    batch: async () => []
  };
}

// Records which accounts auto-import actually reached out for.
function stubAdapters(db) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('no network expected in this test'); };
  return () => { globalThis.fetch = originalFetch; };
}

test('autoImportClips: an account switched to paste-only is never listed for import', async () => {
  const db = makeDb([
    { id: 1, clipper_id: 1, platform: 'instagram', status: 'connected', access_token: 't', auto_import: 0 }
  ]);
  const restore = stubAdapters(db);
  try {
    // If the paste-only account were selected, the adapter would try to reach
    // the network and this would throw rather than completing cleanly.
    const res = await autoImportClips(db, null, {});
    assert.equal(res.imported, 0);
    assert.equal((res.errors || []).length, 0, 'the account is skipped outright, not attempted-and-failed');
  } finally { restore(); }
});

test('autoImportClips: a normal account is still selected (the filter is not blanket-blocking)', async () => {
  const db = makeDb([
    { id: 2, clipper_id: 1, platform: 'instagram', status: 'connected', access_token: 't', auto_import: 1 }
  ]);
  const restore = stubAdapters(db);
  try {
    const res = await autoImportClips(db, null, {});
    // It WAS selected, so it reached the adapter and failed on the stubbed
    // network -- recorded as a per-account error rather than silently skipped.
    assert.equal((res.errors || []).length, 1, 'an auto_import=1 account is still attempted');
    assert.equal(res.errors[0].account_id, 2);
  } finally { restore(); }
});

test('autoImportClips: paste-only and automatic accounts coexist -- only the automatic one is attempted', async () => {
  // Both Instagram deliberately: YouTube's listRecent returns early when the
  // stored meta has no uploads playlist, so it would never reach the network
  // and the assertion would pass for the wrong reason.
  const db = makeDb([
    { id: 3, clipper_id: 1, platform: 'instagram', status: 'connected', access_token: 't', auto_import: 0 },
    { id: 4, clipper_id: 1, platform: 'instagram', status: 'connected', access_token: 't', auto_import: 1 }
  ]);
  const restore = stubAdapters(db);
  try {
    const res = await autoImportClips(db, null, {});
    const touched = (res.errors || []).map(e => e.account_id);
    assert.deepEqual(touched, [4], 'the same clipper can run one account automatically and one by paste');
  } finally { restore(); }
});
