// Self-tracked D1 usage. Every D1 query result already carries exact
// meta.rows_read/rows_written -- the literal numbers Cloudflare bills
// against -- for free, in-process, with zero lag. This wraps the DB
// binding once per Worker invocation, accumulates those numbers, and
// flushes ONE increment write at the end -- never a write per query,
// which would burn write-quota just to measure read-quota.
//
// D1's Free-tier daily quota (5,000,000 rows read/day) hard-failed every
// request on 2026-09-13 with zero warning (commit 8443202). The account
// is now on Workers Paid, which bills per-unit past a MONTHLY included
// allowance instead of hard-failing at a daily wall -- so the alert here
// checks the current UTC month's running total against that allowance,
// not a single day's row against a daily cap. The daily row is still
// tracked (for a same-day "pace" early-warning figure and the trend view
// on the admin tab), it just is not what the alert fires on.
//
// Deliberately self-tracked, not Cloudflare's GraphQL Analytics API: no
// new API token, no lag, no separate rate limit, and the number is exact
// rather than adaptively sampled -- there is no upside to routing this
// through an external service when the exact figure is already sitting
// in the response object. (CPU time and Workers Logs volume are the
// opposite case -- see the P3 module for why those DO use the real API.)
import { now } from './db.js';
import { logError } from './error-log.js';
import { logAction } from './audit.js';

// Workers Paid, verified against Cloudflare's own docs, 2026-09-14.
export const D1_MONTHLY_LIMITS = { rowsRead: 25_000_000_000, rowsWritten: 50_000_000 };

export const todayUTC = () => new Date().toISOString().slice(0, 10);
export const monthUTC = (day = todayUTC()) => day.slice(0, 7);

/**
 * Wraps a D1 binding so every .prepare()/.bind()/.all()/.run()/.batch()
 * call made through the wrapper accumulates real rows_read/rows_written
 * into closured counters for THIS ONE invocation. Nothing is written to
 * D1 per query -- flushUsage() below does one write, once, at the end.
 *
 * .batch() results are returned completely unmodified (not cloned, no
 * fields stripped) -- callers elsewhere in this codebase (finance.js,
 * payouts.js) read result[i].meta.last_row_id straight off a batch's
 * return value and must keep working exactly as before.
 *
 * Known, deliberate blind spot: real D1's .first() returns the bare row
 * (or null, or a single column's value) with no `meta` at all -- there is
 * no rows_read to absorb from it. NOT compensated for by re-issuing the
 * same query as .all() -- that would inflate the exact thing being
 * measured just to measure it more precisely. The counter this produces
 * is a floor, not an exact total, and that is an acceptable, documented
 * tradeoff rather than a bug to chase.
 */
export function wrapD1(db) {
  let rowsRead = 0, rowsWritten = 0;

  const absorb = (meta) => {
    if (!meta) return;
    rowsRead += meta.rows_read || 0;
    rowsWritten += meta.rows_written || 0;
  };

  const wrapStatement = (stmt) => ({
    bind: (...a) => wrapStatement(stmt.bind(...a)),
    async all() { const r = await stmt.all(); absorb(r.meta); return r; },
    first: (...a) => stmt.first(...a),
    async run() { const r = await stmt.run(); absorb(r.meta); return r; },
    // Exposed so the wrapped .batch() below can hand the real statements
    // to the real db.batch() -- D1 has no idea what to do with our shape.
    _unwrap: stmt
  });

  return {
    prepare(sql) { return wrapStatement(db.prepare(sql)); },
    async batch(stmts) {
      const real = stmts.map(s => (s && s._unwrap) ? s._unwrap : s);
      const results = await db.batch(real);
      for (const r of results) absorb(r && r.meta);
      return results;
    },
    _usage: () => ({ rowsRead, rowsWritten }),
    // The original, unwrapped binding -- used for the flush write itself
    // so that write is never recursively counted.
    _raw: db
  };
}

const RECOMMENDATION =
  'Recommended: pause heavy sync from the Platform Usage tab -- the ' +
  'The hourly refresh is the largest known D1 consumer. This is ' +
  'visibility only; nothing has been disabled automatically.';

/**
 * Called ONCE, at the end of a Worker invocation, with the ORIGINAL
 * (unwrapped) db -- so this write is never itself counted, and wrapD1
 * never needs to special-case "this one query is mine, don't track it."
 */
export async function flushUsage(rawDb, { rowsRead, rowsWritten } = {}) {
  if (!rowsRead && !rowsWritten) return; // e.g. a static-asset request touched no D1 at all

  const day = todayUTC();
  await rawDb.prepare(
    `INSERT INTO d1_usage_daily (day, rows_read, rows_written, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       rows_read = rows_read + excluded.rows_read,
       rows_written = rows_written + excluded.rows_written,
       updated_at = excluded.updated_at`
  ).bind(day, rowsRead || 0, rowsWritten || 0, now()).run();

  await checkMonthlyThreshold(rawDb, day);
}

async function monthlyTotals(db, month) {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(rows_read),0) AS rows_read, COALESCE(SUM(rows_written),0) AS rows_written
     FROM d1_usage_daily WHERE day LIKE ?`
  ).bind(`${month}-%`).first();
  return row || { rows_read: 0, rows_written: 0 };
}

/**
 * 90% is checked before 70% so a jump straight past both in one flush
 * (plausible right after the cron's big sync batch) fires the critical
 * alert, not just the warning. Setting warned70 alongside warned90 means
 * a later flush that's still under 90% but over 70% never re-fires the
 * warning after the critical alert already covered it.
 */
async function checkMonthlyThreshold(rawDb, day) {
  const month = monthUTC(day);
  const totals = await monthlyTotals(rawDb, month);
  const readPct = totals.rows_read / D1_MONTHLY_LIMITS.rowsRead;
  const writtenPct = totals.rows_written / D1_MONTHLY_LIMITS.rowsWritten;
  const pct = Math.max(readPct, writtenPct);
  if (pct < 0.7) return;

  const dimension = readPct >= writtenPct ? 'rows read' : 'rows written';
  const scope = `d1:${month}`;
  const alert = await rawDb.prepare(
    'SELECT warned_70_at, warned_90_at FROM platform_usage_alerts WHERE scope = ?'
  ).bind(scope).first();

  if (pct >= 0.9 && !(alert && alert.warned_90_at)) {
    await logError(rawDb, {
      actorType: 'system', source: 'platform_usage', code: 'D1_MONTHLY_CRITICAL',
      message: `D1 ${dimension} at ${(pct * 100).toFixed(1)}% of this month's Workers Paid included allowance. ${RECOMMENDATION}`
    });
    await upsertAlertState(rawDb, scope, { warned70: true, warned90: true });
  } else if (pct >= 0.7 && !(alert && alert.warned_70_at)) {
    await logError(rawDb, {
      actorType: 'system', source: 'platform_usage', code: 'D1_MONTHLY_WARN',
      message: `D1 ${dimension} at ${(pct * 100).toFixed(1)}% of this month's Workers Paid included allowance. ${RECOMMENDATION}`
    });
    await upsertAlertState(rawDb, scope, { warned70: true });
  }
}

async function upsertAlertState(db, scope, { warned70, warned90 } = {}) {
  const ts = now();
  await db.prepare(
    `INSERT INTO platform_usage_alerts (scope, warned_70_at, warned_90_at) VALUES (?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       warned_70_at = COALESCE(platform_usage_alerts.warned_70_at, excluded.warned_70_at),
       warned_90_at = COALESCE(platform_usage_alerts.warned_90_at, excluded.warned_90_at)`
  ).bind(scope, warned70 ? ts : null, warned90 ? ts : null).run();
}

/* ─────────────────────────── pause control ─────────────────────────── */
//
// One admin-togglable switch (system_pause, migration 042) gating heavy
// background work only -- createRefreshJob()'s 'global' kind, which
// covers both the hourly cron AND an admin's own manual "full refresh"
// button. Every clipper/client/admin-facing feature keeps working
// untouched. Deliberately one-click, never automatic: the admin decides,
// the system just makes the decision-relevant numbers impossible to miss.

export async function isPaused(db) {
  const row = await db.prepare('SELECT paused FROM system_pause WHERE id = 1').first();
  return !!(row && row.paused);
}

/** Normalises the raw 0/1 SQLite value to a real boolean for API responses. */
export async function getPauseState(db) {
  const row = await db.prepare(
    'SELECT paused, paused_at, paused_by, reason FROM system_pause WHERE id = 1'
  ).first();
  return {
    paused: !!(row && row.paused),
    paused_at: row ? row.paused_at : null,
    paused_by: row ? row.paused_by : null,
    reason: row ? row.reason : null
  };
}

/** A deliberate human action, not a system-detected condition -- logged via logAction (staff_audit_log), not logError. */
export async function setPaused(db, { paused, staffName = 'Admin', reason = null }) {
  const ts = now();
  await db.prepare(
    'UPDATE system_pause SET paused = ?, paused_at = ?, paused_by = ?, reason = ? WHERE id = 1'
  ).bind(paused ? 1 : 0, paused ? ts : null, paused ? staffName : null, paused ? reason : null).run();

  await logAction(db, {
    staffType: 'admin', staffName,
    action: paused ? 'heavy_sync_paused' : 'heavy_sync_resumed',
    targetType: 'system', targetLabel: 'Heavy background sync', detail: reason
  });
}

/* ────────────────────────── read-side shaping ────────────────────────── */

/** For GET /api/admin/platform-usage. */
export async function platformUsageSnapshot(db) {
  const day = todayUTC();
  const month = monthUTC(day);
  const [todayRow, monthTotals, historyResult, pause] = await Promise.all([
    db.prepare('SELECT rows_read, rows_written FROM d1_usage_daily WHERE day = ?').bind(day).first(),
    monthlyTotals(db, month),
    db.prepare('SELECT day, rows_read, rows_written FROM d1_usage_daily ORDER BY day DESC LIMIT 30').all(),
    getPauseState(db)
  ]);

  const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  // Same average-pace framing named in the plan: a rough per-day target
  // derived from the monthly allowance, purely an early-warning signal --
  // Workers Paid has no real per-day cutoff the way Free's daily quota did.
  const dailyPaceTarget = {
    rows_read: Math.round(D1_MONTHLY_LIMITS.rowsRead / daysInMonth),
    rows_written: Math.round(D1_MONTHLY_LIMITS.rowsWritten / daysInMonth)
  };

  return {
    day, month,
    today: {
      rows_read: todayRow ? todayRow.rows_read : 0,
      rows_written: todayRow ? todayRow.rows_written : 0
    },
    daily_pace_target: dailyPaceTarget,
    month_to_date: monthTotals,
    limits: D1_MONTHLY_LIMITS,
    pct_read: monthTotals.rows_read / D1_MONTHLY_LIMITS.rowsRead,
    pct_written: monthTotals.rows_written / D1_MONTHLY_LIMITS.rowsWritten,
    history: (historyResult.results || []).reverse(), // oldest first, for a left-to-right trend
    pause
  };
}
