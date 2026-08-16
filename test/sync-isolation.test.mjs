// Regression test for a real production incident (see the commit that added
// this file): a single clip's view-fetch failing anywhere in a sync batch
// used to throw out of the whole batch, discarding every other clip's
// already-fetched result and freezing an entire account's views until a
// fully-clean run happened by chance. Root cause: src/platforms.js's
// Instagram adapter looped `await`s with no per-item try/catch, so any one
// throw aborted the loop and lost everything already fetched; the same
// unbounded-blast-radius shape existed for YouTube one batch-of-50 up.
//
// This test proves that shape is closed on both platforms: one failing item
// (or one failing batch, for YouTube) must never affect any other item's
// outcome, and a genuinely deleted post must still be told apart from a
// fetch that merely failed transiently.
//
// Both adapters take an injectable fetch function specifically so this test
// can prove the real isolation logic without mocking the network or an ES
// module -- production call sites never pass it, so real code always uses
// the real API.
//
// Run with: npm test  (node --test test/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdapter } from '../src/platforms.js';
import { fetchVideoDetails, VIEW_BATCH_SIZE } from '../src/youtube.js';

// ------------------------------------------------------------- Instagram

test('Instagram fetchViews: one clip failing does not affect the others', async () => {
  const instagram = getAdapter('instagram');

  // 5 clips; the 3rd throws mid-loop, exactly like a transient rate limit or
  // network blip does in production.
  const fetchOne = async (id) => {
    if (id === 'bad-3') throw Object.assign(new Error('boom'), { code: 'NETWORK' });
    return { good: 100, 'good-2': 200, 'good-4': 400, 'good-5': 500 }[id];
  };

  const results = await instagram.fetchViews(
    { access_token: 'tok' },
    ['good', 'good-2', 'bad-3', 'good-4', 'good-5'],
    {},
    { fetchOne }
  );

  assert.deepEqual(results.get('good'), { ok: true, views: 100 });
  assert.deepEqual(results.get('good-2'), { ok: true, views: 200 });
  assert.deepEqual(results.get('good-4'), { ok: true, views: 400 });
  assert.deepEqual(results.get('good-5'), { ok: true, views: 500 });

  // The failing clip gets its own isolated error -- fetchViews does not
  // throw, and the failure does not erase or block the four clips around it.
  const failed = results.get('bad-3');
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'NETWORK');
});

test('Instagram fetchViews: needsReauth is recorded per-clip, never thrown', async () => {
  const instagram = getAdapter('instagram');
  const fetchOne = async (id) => {
    if (id === 'expired') throw Object.assign(new Error('token'), { code: 'TOKEN_EXPIRED', needsReauth: true });
    return 42;
  };

  const results = await instagram.fetchViews({ access_token: 'tok' }, ['ok-1', 'expired'], {}, { fetchOne });
  assert.deepEqual(results.get('ok-1'), { ok: true, views: 42 });
  assert.equal(results.get('expired').ok, false);
  assert.equal(results.get('expired').needsReauth, true);
});

// ----------------------------------------------------------------- YouTube

test('YouTube fetchVideoDetails: one failing batch of 50 does not affect other batches', async () => {
  // 3 batches worth of ids (VIEW_BATCH_SIZE=50 per call). The middle batch's
  // HTTP call fails; the first and third batches must still come back intact.
  const ids = Array.from({ length: VIEW_BATCH_SIZE * 3 }, (_, i) => `v${i}`);

  let call = 0;
  const fetchOneBatch = async (url) => {
    call++;
    if (call === 2) throw Object.assign(new Error('quota'), { code: 'QUOTA' });
    const batchIds = new URL(url).searchParams.get('id').split(',');
    return { items: batchIds.map(id => ({ id, statistics: { viewCount: '10' } })) };
  };

  const items = await fetchVideoDetails(ids, 'tok', null, fetchOneBatch);

  // Batch 1 (indices 0-49) and batch 3 (indices 100-149) succeeded normally.
  const batch1 = items.find(i => i.id === 'v0');
  const batch3 = items.find(i => i.id === 'v100');
  assert.equal(batch1.statistics.viewCount, '10');
  assert.equal(batch3.statistics.viewCount, '10');

  // Batch 2 (indices 50-99) is marked with its own error, isolated to just
  // those 50 ids -- not thrown, and not confused with "video not found".
  const failedItem = items.find(i => i.id === 'v50');
  assert.equal(failedItem.__batchError, 'QUOTA');
  assert.equal(items.filter(i => i.__batchError).length, VIEW_BATCH_SIZE);
});
