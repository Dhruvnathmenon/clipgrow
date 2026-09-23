// Exponential back-off between retries, so nobody can send request after request
// back to back.
//
// Every rejection doubles the wait before the next try: one hour after the first,
// two after the second, four after the third, and so on up to a day. A person who
// has read the feedback and fixed the problem barely notices it (a reviewer takes
// up to a day to answer anyway); someone firing the same thing repeatedly, hoping
// one gets through, is slowed to a crawl. Nothing here judges anyone -- it only
// makes the cost of a careless retry go up.
//
// Pure functions of "how many times has this been rejected, and when was the last",
// so both the server (which enforces it) and the tests use the same arithmetic,
// and nothing needs a counter that could drift from the rows it describes.

export const RETRY_BASE_MS = 60 * 60 * 1000;
export const RETRY_CAP_MS = 24 * 60 * 60 * 1000;

/** How long to wait after the Nth rejection (N = 1 is the first). */
export function retryDelayMs(rejections) {
  const n = Math.floor(Number(rejections) || 0);
  if (n < 1) return 0;
  // The exponent is capped before the multiply so a huge count cannot overflow to
  // Infinity, and then the result is capped at a day.
  return Math.min(RETRY_BASE_MS * 2 ** Math.min(n - 1, 20), RETRY_CAP_MS);
}

/**
 * null when the caller may try now, otherwise { retry_in_ms, retry_at }.
 * `lastRejectedAt` is when the most recent rejection happened (ms). Unknown means
 * no wait: a missing timestamp must never lock someone out.
 */
export function retryWindow(rejections, lastRejectedAt, at = Date.now()) {
  const delay = retryDelayMs(rejections);
  const last = Number(lastRejectedAt);
  if (!delay || !last) return null;
  const retryAt = last + delay;
  return retryAt > at ? { retry_in_ms: retryAt - at, retry_at: retryAt } : null;
}

/** "1h 12m", "45m", "30s" -- rounded up so it never says "0m" while still waiting. */
export function waitText(ms) {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}
