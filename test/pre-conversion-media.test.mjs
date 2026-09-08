// A real production case: an Instagram clip posted before the account switched
// from Personal to Business/Creator can never return insights, ever. Verified
// directly against the live Graph API (subcode 2108006). This was previously
// misclassified into the generic code-100 fallback as PERMISSION_MISSING,
// which told the clipper to "leave every permission ticked and reconnect" --
// advice that can never fix a fact about when a post was published, and which
// left the health banner flagging the same two clips as "not syncing" forever
// since nothing could ever make them succeed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/instagram.js';
import { clipState, clipStateMessage } from '../src/clipstate.js';

const REAL_BODY = {
  error: {
    message: "The media was posted before the most recent time that the user's account was converted to a business account from a personal account.",
    type: 'IGApiException',
    code: 100,
    error_subcode: 2108006,
    fbtrace_id: 'AGFD9LRa6X-V8vvhdhsyioU'
  }
};

test('classify: subcode 2108006 is PRE_CONVERSION_MEDIA, not PERMISSION_MISSING', () => {
  const err = classify(400, REAL_BODY);
  assert.equal(err.code, 'PRE_CONVERSION_MEDIA');
  assert.equal(err.needsReauth, false, 'reconnecting can never fix this -- it must not trigger a reconnect flow');
});

test('classify: a different code-100 message still falls through to PERMISSION_MISSING', () => {
  const err = classify(400, { error: { code: 100, message: 'Some other Graph API complaint' } });
  assert.equal(err.code, 'PERMISSION_MISSING');
});

test('clipState: PRE_CONVERSION_MEDIA reads as its own settled state, not a reconnect prompt', () => {
  // created_at is NOT NULL in production -- a real row always has one.
  // Without it here, the 7-day tracking-window check reads a missing
  // timestamp as "created in 1970" and always wins, which isn't what this
  // test is exercising.
  const state = clipState({ sync_error: 'PRE_CONVERSION_MEDIA', locked_at: null, eligible: 1, status: 'active', created_at: Date.now() });
  assert.equal(state, 'no_insights');
  assert.notEqual(state, 'reconnect');
});

test('clipStateMessage: explains the permanent fact, not "views last updated"', () => {
  const msg = clipStateMessage('no_insights', { sync_error: 'PRE_CONVERSION_MEDIA', last_ok_sync_at: null });
  assert.match(msg, /before this account switched/i);
  assert.doesNotMatch(msg, /views last updated/i, 'a staleness note implies this might still update, which it never will');
});
