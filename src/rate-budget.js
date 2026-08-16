// Instagram's real rate limit: 200 calls/hour, per connected account, on a
// ROLLING window (Meta: "every API call advances the window forward by one
// hour" -- not a fixed clock-hour reset). Batching does not reduce this --
// Meta's own batch-request docs say every call inside a batch still counts
// individually. So the only real lever is spending the budget deliberately,
// which is what this module exists to make possible: an accurate, dynamic,
// self-consistent count of what an account has actually used and has left,
// built from calls we know we made rather than trusted from response headers
// that are not reliably present on every call.

export const HOURLY_LIMIT = 200;
const WINDOW_MS = 60 * 60 * 1000;
// A clip that synced successfully within this window is not re-fetched, full
// refresh or individual -- there is nothing fresher to get within the hour,
// and re-asking would just spend budget for the same number.
export const CLIP_COOLDOWN_MS = 60 * 60 * 1000;
// A full refresh needs every eligible clip to fit in one hour's ceiling, full
// stop -- no partial/priority attempt. An account that outgrows this needs
// its old clips locked/paid down below the line, not a cleverer sync order.
export const MAX_CLIPS_FOR_FULL_REFRESH = HOURLY_LIMIT;

/**
 * Buffers call timestamps in memory during a sync run and writes them to D1
 * once at the end, instead of one write per API call. A sync touching 150
 * clips should cost 150 Instagram calls, not 150 Instagram calls *and* 150
 * database writes on top.
 */
export function makeCallCounter(accountId) {
  const pending = [];
  return {
    accountId,
    count: () => pending.length,
    onAttempt: () => { pending.push(Date.now()); },
    async flush(db) {
      if (!pending.length) return;
      const stmts = pending.map(ts =>
        db.prepare('INSERT INTO ig_api_calls (social_account_id, called_at) VALUES (?, ?)').bind(accountId, ts));
      pending.length = 0;
      await db.batch(stmts);
    }
  };
}

/**
 * What an account has used and has left, right now, in the rolling window.
 * `resetInMs` is the time until the OLDEST call currently counted ages out --
 * not a countdown to a fixed clock boundary, because there isn't one. Budget
 * actually frees up continuously as old calls fall out of the window, one at
 * a time, not in one lump at the top of an hour.
 */
export async function getBudget(db, accountId) {
  const since = Date.now() - WINDOW_MS;
  const { results } = await db.prepare(
    'SELECT called_at FROM ig_api_calls WHERE social_account_id = ? AND called_at > ? ORDER BY called_at ASC'
  ).bind(accountId, since).all();

  const used = (results || []).length;
  const remaining = Math.max(0, HOURLY_LIMIT - used);
  const oldest = results && results[0] ? results[0].called_at : null;
  const resetInMs = oldest ? Math.max(0, (oldest + WINDOW_MS) - Date.now()) : 0;

  return {
    used,
    remaining,
    limit: HOURLY_LIMIT,
    reset_in_ms: resetInMs,
    // The same leftover budget, expressed the two ways that are actually
    // useful to look at rather than a raw call count.
    full_refreshes_available: eligibleCount => eligibleCount > 0 ? Math.floor(remaining / eligibleCount) : 0,
    single_refreshes_available: remaining
  };
}

/** Opportunistic cleanup so this table never grows unbounded. Safe to call often. */
export async function pruneOldCalls(db, accountId) {
  await db.prepare('DELETE FROM ig_api_calls WHERE social_account_id = ? AND called_at < ?')
    .bind(accountId, Date.now() - WINDOW_MS).run();
}
