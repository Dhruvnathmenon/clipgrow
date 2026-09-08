// Durable, attributable history of what each refresh did to each clip.
//
// See migrations/020_refresh_events.sql for why this exists. In short: every
// existing record of a refresh failure was a bare count, an account-level code
// with no clip attached, or a single-slot column overwritten on the next run.
// An admin could see that 12 clips failed and never which ones, for whom, or
// why -- while the adapters were generating perfectly good explanations and
// throwing them away.
//
// Everything here is best-effort. Logging must never be able to break a
// refresh: a failure to write history is strictly less bad than a failure to
// sync, so every write is wrapped and swallowed with a console line.


const BY_CODE = [
  [/^(TOKEN_EXPIRED|TOKEN_REVOKED|OAUTH|UNAUTHOR|INVALID_TOKEN|NO_TOKEN|REAUTH)/i, 'reauth'],
  [/(RATE_LIMIT|RATELIMIT|QUOTA|SUBREQUEST_LIMIT|TOO_MANY)/i, 'rate_limit'],
  [/(MEDIA_NOT_FOUND|NOT_FOUND|DELETED|GONE|PRE_CONVERSION_MEDIA)/i, 'gone'],
  [/(NOT_PROFESSIONAL|PERMISSION|FORBIDDEN|SCOPE|NOT_LINKED|NO_INSIGHTS)/i, 'permission'],
  [/(NETWORK|TIMEOUT|FETCH|5\d\d|SERVER_ERROR|UNAVAILABLE)/i, 'network'],
  [/(NO_CAMPAIGN|PLATFORM_NOT_ALLOWED|CONFIG)/i, 'config']
];

/**
 * Sorts an error into a bucket an admin can act on.
 * `needsReauth` from the adapter always wins -- it is the adapter telling us
 * directly, rather than us guessing from the code's spelling.
 */
export function classifyError(err, code) {
  if (err && err.needsReauth) return 'reauth';
  const c = String(code || (err && err.code) || '');
  if (!c) return 'unknown';
  for (const [re, kind] of BY_CODE) if (re.test(c)) return kind;
  return 'unknown';
}

async function safeRun(db, sql, args, what) {
  try {
    await db.prepare(sql).bind(...args).run();
  } catch (e) {
    // Never let history-keeping take down a sync.
    console.error(`[refresh-events] could not record ${what}:`, e && e.message);
  }
}

// Every read of this table (jobEvents, jobFailureSummary) is scoped to one
// specific job_id -- nothing ever queries "the last N days across every
// job" -- so once a job is old enough that nobody is looking at its panel
// any more, its events are pure dead weight. Unlike ig_api_calls (its
// sibling rolling ledger, pruned per-account by src/rate-budget.js), this
// table had no cleanup at all: ~1,200 rows/day with nothing ever removing
// one, forever.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Opportunistic cleanup so this table never grows unbounded. Safe to call often. */
export async function pruneOldEvents(db) {
  try {
    await db.prepare('DELETE FROM refresh_events WHERE created_at < ?')
      .bind(Date.now() - RETENTION_MS).run();
  } catch (e) {
    console.error('[refresh-events] could not prune old events:', e && e.message);
  }
}

/**
 * One clip's outcome.
 *
 * clipper_id, campaign_id, platform and permalink are pulled straight from the
 * submission row in the same statement, so an event is always attributable and
 * cannot drift from the clip it describes.
 */
export async function recordClipEvent(db, {
  jobId, submissionId, accountId = null, outcome, leg = 'view',
  code = null, message = null, fix = null, kind = null, err = null, at = null
}) {
  if (!jobId || !submissionId) return;
  const ts = at || Date.now();
  await safeRun(db,
    `INSERT INTO refresh_events
       (job_id, account_id, clipper_id, campaign_id, submission_id, platform, permalink,
        outcome, leg, kind, code, message, fix, created_at)
     SELECT ?, ?, s.clipper_id, s.campaign_id, s.id, s.platform, s.permalink,
            ?, ?, ?, ?, ?, ?, ?
       FROM submissions s WHERE s.id = ?`,
    [jobId, accountId, outcome, leg, kind || classifyError(err, code), code, message, fix, ts, submissionId],
    `clip ${submissionId}`);
}

/**
 * Many clips at once, for the case that used to record nothing at all: an item
 * that THREW. runChunk caught it, incremented clips_failed by the item's clip
 * count and moved on, so the individual clips kept whatever stale sync_error
 * they already had and the reason existed only as one account-level code.
 */
export async function recordClipEvents(db, submissionIds, common) {
  const ids = [...new Set((submissionIds || []).filter(Boolean))];
  const at = Date.now();
  for (const id of ids) {
    await recordClipEvent(db, { ...common, submissionId: id, at });
  }
  return ids.length;
}

/**
 * An account-level outcome: an import leg, or an account that went away
 * mid-job. Import failures previously contributed ZERO to every counter
 * (countClips returns 0 for import items), so a clipper's new uploads could
 * stop arriving with nothing anywhere reporting it.
 */
export async function recordAccountEvent(db, {
  jobId, account, outcome, leg = 'import',
  code = null, message = null, fix = null, kind = null, err = null
}) {
  if (!jobId || !account) return;
  const accountId = account.account_id || account.id || null;
  await safeRun(db,
    `INSERT INTO refresh_events
       (job_id, account_id, clipper_id, campaign_id, submission_id, platform, permalink,
        outcome, leg, kind, code, message, fix, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [jobId, accountId, account.clipper_id || null, account.campaign_id || null,
     account.platform || null, outcome, leg, kind || classifyError(err, code),
     code, message, fix, Date.now()],
    `account ${accountId}`);
}

/**
 * Everything one job recorded, newest first, failures usable on their own.
 *
 * Returns [] rather than throwing if the table is not there yet, so the code
 * can be deployed before migration 020 has been applied without taking the
 * refresh panel down with it. The writes are already best-effort; the read
 * has to be too, or the deploy order becomes load-bearing.
 */
export async function jobEvents(db, jobId, { outcome = null, limit = 500 } = {}) {
  try {
    return await jobEventsRaw(db, jobId, { outcome, limit });
  } catch (e) {
    console.error('[refresh-events] could not read history:', e && e.message);
    return [];
  }
}

async function jobEventsRaw(db, jobId, { outcome = null, limit = 500 } = {}) {
  const { results } = await db.prepare(
    `SELECT e.*, cl.username AS clipper_username, cl.display_name AS clipper_name,
            c.name AS campaign_name
       FROM refresh_events e
       LEFT JOIN clippers cl ON cl.id = e.clipper_id
       LEFT JOIN campaigns c ON c.id = e.campaign_id
      WHERE e.job_id = ? ${outcome ? 'AND e.outcome = ?' : ''}
      ORDER BY e.id DESC LIMIT ?`
  ).bind(...(outcome ? [jobId, outcome, limit] : [jobId, limit])).all();
  return results || [];
}

/**
 * Failures from one job, grouped the way an admin reads them: by clipper, then
 * by account, with the reason and the fix attached. This is the shape the
 * refresh panel renders.
 */
export async function jobFailureSummary(db, jobId) {
  const rows = await jobEvents(db, jobId, { outcome: 'failed', limit: 1000 });
  const byClipper = new Map();
  for (const r of rows) {
    const key = String(r.clipper_id || 0);
    if (!byClipper.has(key)) {
      byClipper.set(key, {
        clipper_id: r.clipper_id,
        clipper: r.clipper_name || r.clipper_username || 'unknown clipper',
        accounts: new Map()
      });
    }
    const cl = byClipper.get(key);
    const akey = String(r.account_id || 0) + ':' + (r.platform || '');
    if (!cl.accounts.has(akey)) {
      cl.accounts.set(akey, { account_id: r.account_id, platform: r.platform, clips: [] });
    }
    cl.accounts.get(akey).clips.push({
      submission_id: r.submission_id,
      permalink: r.permalink,
      campaign: r.campaign_name,
      leg: r.leg,
      kind: r.kind,
      code: r.code,
      message: r.message,
      fix: r.fix
    });
  }
  return [...byClipper.values()].map(c => ({
    ...c,
    accounts: [...c.accounts.values()]
  }));
}
