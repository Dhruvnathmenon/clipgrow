// The bug this guards against: a clipper's YouTube uploads stopped being
// imported for three days, with no error surfaced anywhere -- the account
// still read status='connected' with a null error code the whole time.
//
// Two independent defects combined to produce that:
//
//  1. listRecent() returns every video posted since the account was connected,
//     and YouTube probes each candidate with its own external request to work
//     out whether it is a Short. Dedup happened in the CALLER, afterwards, so
//     the per-run cost grew with the channel's entire history instead of with
//     what was actually new -- until a run no longer fit in one Worker
//     invocation's subrequest budget and the import failed outright.
//  2. That failure was then swallowed: the catch recorded nothing unless the
//     error happened to be an auth error, so nothing anywhere showed a
//     problem. The only symptom was an absence, and nothing watched for one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listRecent } from '../src/youtube.js';

// A fake channel with a playlist of videos. Counts how many videos actually
// reach the expensive stage, which is the number that used to grow forever.
function makeAccount(videoIds) {
  return {
    external_id: 'UC_test',
    access_token: 'tok',
    meta_json: JSON.stringify({ uploads_playlist: 'UU_test' }),
    __videoIds: videoIds
  };
}

function installFetchStub(account, counters) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);

    if (u.includes('/playlistItems')) {
      counters.playlistItems++;
      return new Response(JSON.stringify({
        items: account.__videoIds.map(id => ({
          contentDetails: { videoId: id, videoPublishedAt: '2026-08-19T00:00:00Z' }
        }))
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (u.includes('/videos')) {
      counters.videosList++;
      const ids = new URL(u).searchParams.get('id').split(',');
      counters.videosRequested.push(...ids);
      return new Response(JSON.stringify({
        items: ids.map(id => ({
          id,
          status: { privacyStatus: 'public' },
          contentDetails: { duration: 'PT10S' },
          snippet: { title: 't', publishedAt: '2026-08-19T00:00:00Z', thumbnails: {} },
          statistics: { viewCount: '1' }
        }))
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // The Shorts probe -- one external request per video. This is the count
    // that used to scale with the whole channel history on every single run.
    if (u.includes('youtube.com/shorts/')) {
      counters.shortsProbes++;
      return new Response(null, { status: 200 });
    }

    throw new Error('unexpected fetch: ' + u);
  };
  return () => { globalThis.fetch = realFetch; };
}

test('listRecent: skips the per-video Shorts probe for videos already recorded', async () => {
  const ids = Array.from({ length: 27 }, (_, i) => `vid${i}`);
  const account = makeAccount(ids);
  const counters = { playlistItems: 0, videosList: 0, shortsProbes: 0, videosRequested: [] };
  const restore = installFetchStub(account, counters);

  try {
    // 26 of the 27 are already imported; only one is genuinely new.
    const knownIds = new Set(ids.slice(0, 26));
    const out = await listRecent(account, { sinceTs: 0, knownIds }, {});

    assert.equal(out.length, 1, 'only the new video is returned');
    assert.equal(counters.shortsProbes, 1,
      'exactly one probe -- not one per video in the channel history');
    assert.deepEqual(counters.videosRequested, ['vid26'],
      'already-known videos are not even looked up');
  } finally {
    restore();
  }
});

test('listRecent: without knownIds every video is still probed (the old, unbounded behaviour)', async () => {
  const ids = Array.from({ length: 27 }, (_, i) => `vid${i}`);
  const account = makeAccount(ids);
  const counters = { playlistItems: 0, videosList: 0, shortsProbes: 0, videosRequested: [] };
  const restore = installFetchStub(account, counters);

  try {
    const out = await listRecent(account, { sinceTs: 0 }, {});
    assert.equal(out.length, 27);
    assert.equal(counters.shortsProbes, 27,
      'this is the cost that grew until an import no longer fit in one invocation');
  } finally {
    restore();
  }
});

test('listRecent: when everything is already known it does no expensive work at all', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `vid${i}`);
  const account = makeAccount(ids);
  const counters = { playlistItems: 0, videosList: 0, shortsProbes: 0, videosRequested: [] };
  const restore = installFetchStub(account, counters);

  try {
    const out = await listRecent(account, { sinceTs: 0, knownIds: new Set(ids) }, {});
    assert.equal(out.length, 0);
    assert.equal(counters.videosList, 0, 'no videos.list call');
    assert.equal(counters.shortsProbes, 0, 'no probes');
  } finally {
    restore();
  }
});
