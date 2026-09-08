// A clip that has never had a successful sync has no last_ok_sync_at to
// measure staleness from. Falling back to 0 there (instead of when the clip
// actually started being tracked) made a brand-new clip's very first failed
// attempt read as having been stale for decades -- escalating to 'unavailable'
// immediately instead of the expected transient 'issue'. Confirmed live: a
// real production clip 5 minutes old with one NETWORK failure was showing as
// "stuck 12+ hours" in the admin overview because of this exact bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipState } from '../src/clipstate.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function sub(overrides = {}) {
  const now = Date.now();
  return {
    locked_at: null, status: 'active', eligible: 1, sync_error: null,
    last_ok_sync_at: null, created_at: now, views: 0, min_views: 1000,
    ...overrides
  };
}

test('clipState: a brand-new clip whose first sync attempt just failed reads as "issue", not "unavailable"', () => {
  const now = Date.now();
  const s = sub({ sync_error: 'NETWORK', created_at: now - 60 * 1000, last_ok_sync_at: null }); // 1 min old
  assert.equal(clipState(s), 'issue', 'one transient failure on a fresh clip must not escalate immediately');
});

test('clipState: a clip that has been failing since it was created, for longer than the stale window, reads as "unavailable"', () => {
  const now = Date.now();
  const s = sub({ sync_error: 'NETWORK', created_at: now - 4 * DAY_MS, last_ok_sync_at: null }); // 4 days old, never synced
  assert.equal(clipState(s), 'unavailable', 'a clip failing since creation for days genuinely is stuck');
});

test('clipState: a clip that WAS syncing fine and only recently started failing reads as "issue"', () => {
  const now = Date.now();
  // 6 days old -- still inside the 7-day tracking window, so this exercises
  // the recency-vs-staleness logic rather than the tracking_complete cutoff.
  const s = sub({ sync_error: 'NETWORK', created_at: now - 6 * DAY_MS, last_ok_sync_at: now - 10 * 60 * 1000 });
  assert.equal(clipState(s), 'issue', 'recent success should still count, regardless of how old the clip itself is');
});

test('clipState: a clip that WAS syncing fine and has been failing since well past the stale window reads as "unavailable"', () => {
  const now = Date.now();
  const s = sub({ sync_error: 'NETWORK', created_at: now - 6 * DAY_MS, last_ok_sync_at: now - 4 * DAY_MS });
  assert.equal(clipState(s), 'unavailable');
});

test('clipState: a clip past its 7-day tracking window reads as "tracking_complete", even with an active sync_error', () => {
  const now = Date.now();
  // Once the window has closed, WHY a clip stopped moving no longer matters --
  // it outranks every sync_error branch, including ones that would otherwise
  // read as a genuine open problem ('unavailable', 'reconnect').
  const s = sub({ sync_error: 'TOKEN_EXPIRED', created_at: now - 8 * DAY_MS, last_ok_sync_at: now - 8 * DAY_MS });
  assert.equal(clipState(s), 'tracking_complete');
});

test('clipState: a clip still inside its 7-day window is unaffected by the new cutoff', () => {
  const now = Date.now();
  const s = sub({ created_at: now - 6 * DAY_MS, last_ok_sync_at: now, views: 5000 });
  assert.equal(clipState(s), 'tracking', 'a healthy clip within the window behaves exactly as before');
});

test('clipState: locked/disqualified/paused outrank the tracking window even on an old clip', () => {
  const now = Date.now();
  const old = { created_at: now - 30 * DAY_MS };
  assert.equal(clipState(sub({ ...old, locked_at: now })), 'locked');
  assert.equal(clipState(sub({ ...old, status: 'disqualified' })), 'disqualified');
  assert.equal(clipState(sub({ ...old, status: 'paused' })), 'paused');
});
