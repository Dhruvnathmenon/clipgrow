// One place that decides what a clip's situation actually is, so the clipper
// dashboard, the admin panel and the client view can never disagree about it.
//
// The important distinction is between "we haven't heard yet" (a fresh Reel
// whose insights Instagram hasn't published) and "we asked and something is
// genuinely wrong" (post deleted, account banned, permission pulled). The old
// code could not tell these apart because `last_synced_at` was stamped on
// failures too; `last_ok_sync_at` (migration 011) records only real answers.

const DAY_MS = 24 * 60 * 60 * 1000;

// How long a clip may go without a successful view fetch before it stops being
// "a hiccup" and starts being reported as genuinely stuck.
export const STALE_AFTER_MS = 3 * DAY_MS;

export function daysSince(ts) {
  if (!ts) return null;
  return Math.floor((Date.now() - ts) / DAY_MS);
}

/**
 * @param s a submission row, optionally joined with the campaign's min_views.
 */
export function clipState(s) {
  if (s.locked_at) return 'locked';
  if (s.status === 'disqualified') return 'disqualified';
  if (s.status === 'paused') return 'paused';
  // Ruled out by the platform's own rules at import time -- currently a
  // YouTube upload that is not a Short. Tracked and visible, never earns.
  if (s.eligible === 0) return 'ineligible';

  if (s.sync_error) {
    if (s.sync_error === 'MEDIA_NOT_FOUND') return 'removed';
    // Permanent and explained, same footing as 'removed': there is a fact
    // about this clip that will never change, so it should read as settled
    // information rather than an open problem waiting on anyone.
    if (s.sync_error === 'PRE_CONVERSION_MEDIA') return 'no_insights';
    if (s.sync_error === 'NO_ACCOUNT') return 'disconnected';
    if (s.sync_error === 'TOKEN_EXPIRED' || s.sync_error === 'TOKEN_REVOKED' ||
        s.sync_error === 'PERMISSION_MISSING' || s.sync_error === 'NOT_A_TESTER') {
      return 'reconnect';
    }
    // Anything else (rate limits, transient Instagram faults) is only worth
    // escalating once it has persisted long enough to stop being noise. A
    // clip that has never had a successful sync has no `last_ok_sync_at` to
    // measure from -- falling back to 0 there (instead of when the clip
    // actually started being tracked) made `Date.now() - 0` enormous, so a
    // brand-new clip's very first failed attempt was misread as having been
    // stale for decades and escalated to 'unavailable' immediately. Falling
    // back to `created_at` instead measures from when tracking actually
    // began, so one transient failure reads as 'issue' (expected to clear on
    // its own) until it has genuinely persisted for STALE_AFTER_MS.
    const since = s.last_ok_sync_at || s.created_at || 0;
    return (!since || Date.now() - since > STALE_AFTER_MS) ? 'unavailable' : 'issue';
  }

  if (!s.last_ok_sync_at) return 'verified';
  if (s.min_views && s.views < s.min_views) return 'below_min';
  return 'tracking';
}

/**
 * Plain-English explanation of a state, aimed at the clipper. Returns null for
 * healthy states, which need no explaining.
 */
export function clipStateMessage(state, s) {
  const stale = daysSince(s.last_ok_sync_at);
  const staleNote = stale == null
    ? 'Views have never updated for this clip.'
    : stale === 0
      ? 'Views last updated today.'
      : `Views last updated ${stale} day${stale === 1 ? '' : 's'} ago.`;
  // Wording follows the clip's own platform, so a YouTube problem never tells
  // a clipper to go and check Instagram.
  const site = (s.platform || 'instagram') === 'youtube' ? 'YouTube' : 'Instagram';

  switch (state) {
    case 'ineligible':
      return s.platform === 'youtube'
        ? 'This campaign pays on YouTube Shorts, and this upload is not a Short, so it does not earn.'
        : 'This clip does not meet the campaign\'s format rules, so it does not earn.';
    case 'locked':
      return s.lock_reason === 'below_min'
        ? 'Closed: this clip did not reach the campaign minimum in time, so it was settled at zero.'
        : 'Paid and closed. Views after the lock date do not change the amount.';
    case 'removed':
      return `This post is no longer on ${site}, so its views cannot be checked. ${staleNote}`;
    case 'no_insights':
      // No staleNote here on purpose -- appending "views last updated X days
      // ago" to a clip that can never update would read as if it is broken
      // and getting worse, when the true fact is it was never going to work.
      return `Instagram does not provide view counts for anything posted before this account switched to Business/Creator. This one predates that switch, so it can never earn.`;
    case 'disconnected':
      return `The ${site} account this clip was posted from is disconnected. ${staleNote}`;
    case 'reconnect':
      return `The ${site} connection needs re-authorising before views can update. ${staleNote}`;
    case 'unavailable':
      return `${site} has not returned views for this clip in a while. ${staleNote} Tell the ClipGrow admin if it stays this way.`;
    case 'issue':
      return `${site} did not answer on the last check. This usually clears on its own. ${staleNote}`;
    case 'disqualified':
      return 'An admin marked this clip as not eligible, so it earns nothing.';
    case 'paused':
      return 'An admin has paused this clip while it is reviewed. It earns nothing right now.';
    case 'below_min':
      return null;   // the dashboard already shows a "needs N more views" bar
    case 'verified':
      return `Verified. Views start showing once ${site} publishes stats for the post.`;
    default:
      return null;
  }
}

/** True when a clip is stuck badly enough that the admin should act on it. */
export function needsAttention(state) {
  return state === 'removed' || state === 'disconnected' ||
         state === 'reconnect' || state === 'unavailable';
}
