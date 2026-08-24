// Chained refresh jobs.
//
// A refresh used to be one flat pass that had to fit inside a single Worker
// invocation. It did not: Cloudflare caps EXTERNAL subrequests (fetch() to
// Instagram/YouTube -- D1 does not count toward it) per invocation, and a full
// sweep of every account exceeds that. The accounts unlucky enough to be last
// in the loop simply got cut off, which is confirmed in production as clips
// carrying sync_error = 'SUBREQUEST_LIMIT'.
//
// So a refresh is now a JOB: an explicit work list consumed across as many
// invocations as it takes. Each invocation spends up to CALLS_PER_INVOCATION
// external calls, saves exactly what is left, and hands off via Queues to a
// fresh invocation with a fresh budget.
//
// Two ceilings apply and must not be confused:
//   * Cloudflare's per-invocation external-subrequest cap -- what THIS file
//     works around, by splitting one logical refresh across invocations.
//   * Instagram's 200-calls-per-hour PER ACCOUNT -- a wall-clock budget that
//     chaining cannot create more of. src/rate-budget.js owns that, and this
//     file defers to it rather than reimplementing it.

import { getAdapter, campaignPlatforms } from './platforms.js';
import { withAccount } from './earnings.js';
import { makeCallCounter, getBudget, CLIP_COOLDOWN_MS } from './rate-budget.js';
import { VIEW_BATCH_SIZE } from './youtube.js';

// Deliberately under Cloudflare's 50 so a single item that internally retries
// (igFetch backs off and retries on a transient failure, spending more than
// the 1 call it was budgeted) cannot tip the invocation over the real cap
// mid-item and lose that item's work.
export const CALLS_PER_INVOCATION = 40;

// What one work item may cost, used to decide whether it still fits in this
// invocation BEFORE starting it. Import is variable (paging + per-new-video
// Shorts probes) so it is budgeted pessimistically rather than optimistically.
const ITEM_COST = { import: 6, ig_view: 1, yt_views: 1 };

const ACTIVE = ['queued', 'running'];

/* ─────────────────────────── job lifecycle ─────────────────────────── */

export async function getJob(db, jobId) {
  return db.prepare('SELECT * FROM refresh_jobs WHERE id = ?').bind(jobId).first();
}

/**
 * The accounts a job covers, walked strictly through the real hierarchy:
 * campaign -> participation -> account. A clipper in two campaigns therefore
 * gets BOTH campaigns' accounts with no special-casing, because the query
 * asks "every active participation this clipper has" rather than assuming one.
 *
 * Completed campaigns and non-active participations are excluded, matching
 * every other sync path in the codebase.
 */
export async function jobAccounts(db, { clipperId = null } = {}) {
  const { results } = await db.prepare(
    `SELECT DISTINCT a.id AS account_id, a.platform, a.username, a.status,
            a.auto_import, a.access_token, a.external_id, a.meta_json,
            a.refresh_token, a.token_expires_at, a.connected_at,
            p.campaign_id, p.clipper_id, p.status AS part_status, c.allowed_platforms
     FROM participation_accounts pa
     JOIN participations p ON p.id = pa.participation_id
     JOIN campaigns c ON c.id = p.campaign_id
     JOIN social_accounts a ON a.id = pa.account_id
     WHERE a.status = 'connected' AND a.access_token IS NOT NULL
       -- Paused is included deliberately. The campaign page tells a paused
       -- clipper "clips you already posted keep tracking and earning", and the
       -- allocator does keep pricing them -- but excluding them here froze their
       -- views, so they kept earning on a number that could never move. They are
       -- refreshed; only NEW imports are withheld (see buildAccountItems).
       AND p.status IN ('active', 'paused') AND c.status != 'completed'
       ${clipperId ? 'AND p.clipper_id = ?' : ''}
     ORDER BY p.campaign_id, a.id`
  ).bind(...(clipperId ? [clipperId] : [])).all();
  return results || [];
}

/**
 * Builds the work list for one account.
 *
 * `respectCooldown` is the single difference between the automatic cron and a
 * human pressing Refresh. Cron skips clips checked within the last hour --
 * without that, an account with 60 clips would need 240 calls/hour from
 * routine background syncing alone, over Instagram's own 200/hour ceiling
 * before any human asks for anything. A human-triggered full refresh is a
 * deliberate "show me the truth right now", so it checks everything.
 */
export async function buildAccountItems(db, account, { respectCooldown = true } = {}) {
  const items = [];

  // Paused means "submit nothing new", so the import leg is withheld while the
  // view legs below still run. Without this, pausing a clipper would silently
  // keep sweeping their uploads into the campaign.
  if (account.auto_import !== 0 && account.part_status !== 'paused') {
    items.push({ t: 'import', a: account.account_id });
  }

  const { results } = await db.prepare(
    `SELECT id, ig_media_id, last_ok_sync_at FROM submissions
     WHERE account_id = ? AND status = 'active' AND locked_at IS NULL AND eligible != 0
     ORDER BY id`
  ).bind(account.account_id).all();

  const now = Date.now();
  const due = (results || []).filter(s =>
    !respectCooldown || !s.last_ok_sync_at || (now - s.last_ok_sync_at) >= CLIP_COOLDOWN_MS
  );

  if (account.platform === 'youtube') {
    // YouTube returns up to 50 videos per call, so one item per clip would
    // spend 50x the calls for identical data. Batched to match the adapter.
    for (let i = 0; i < due.length; i += VIEW_BATCH_SIZE) {
      const slice = due.slice(i, i + VIEW_BATCH_SIZE);
      items.push({ t: 'yt_views', a: account.account_id, s: slice.map(x => x.id), m: slice.map(x => x.ig_media_id) });
    }
  } else {
    for (const s of due) items.push({ t: 'ig_view', a: account.account_id, s: s.id, m: s.ig_media_id });
  }

  return items;
}

/**
 * Creates a job, or reports that an equivalent one is already running.
 *
 * The "already running" answer comes from the database rejecting the INSERT
 * against a partial unique index, not from a check-then-insert, which would
 * race between the check and the insert.
 */
export async function createRefreshJob(db, { kind, clipperId = null, triggeredBy, respectCooldown = true }) {
  const accounts = await jobAccounts(db, { clipperId });

  // Every account is listed up front with its full video count, so the panel
  // reads as a checklist from the first poll rather than accounts popping into
  // existence as the job happens to reach them.
  let pending = [];
  const acctStats = {};
  for (const acct of accounts) {
    const items = await buildAccountItems(db, acct, { respectCooldown });
    acctStats[String(acct.account_id)] = {
      label: acct.username,
      platform: acct.platform,
      total: items.reduce((n, i) => n + countClips(i), 0),
      done: 0,
      state: 'waiting'
    };
    pending = pending.concat(items);
  }

  const ts = Date.now();
  let res;
  try {
    res = await db.prepare(
      `INSERT INTO refresh_jobs (kind, clipper_id, triggered_by, respect_cooldown, status,
         pending_json, accounts_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`
    ).bind(kind, clipperId, triggeredBy, respectCooldown ? 1 : 0, JSON.stringify(pending),
           JSON.stringify(acctStats), ts, ts).run();
  } catch (e) {
    if (/UNIQUE constraint/i.test(e.message || '')) {
      const existing = await db.prepare(
        `SELECT id FROM refresh_jobs
         WHERE status IN ('queued','running') AND ${clipperId ? 'clipper_id = ?' : "kind = 'global'"}
         ORDER BY id DESC LIMIT 1`
      ).bind(...(clipperId ? [clipperId] : [])).first();
      return { error: 'A refresh is already running.', status: 409, job_id: existing ? existing.id : null };
    }
    throw e;
  }

  return { job_id: res.meta.last_row_id, total_items: pending.length, accounts: accounts.length };
}

/* ─────────────────────────── account locking ─────────────────────────── */

/**
 * Claims an account for this job. An admin global job and a clipper's own job
 * are separate rows, so the per-job indexes cannot stop them touching the same
 * account at once -- this can.
 *
 * A lock held by a job that is no longer active is taken over rather than
 * respected, so a job that died mid-flight cannot block an account forever.
 * Written as ONE conditional UPDATE so the check and the claim cannot
 * interleave with another invocation doing the same thing.
 */
export async function claimAccount(db, accountId, jobId) {
  const res = await db.prepare(
    `UPDATE social_accounts SET active_job_id = ?
     WHERE id = ?
       AND (active_job_id IS NULL
            OR active_job_id = ?
            OR active_job_id NOT IN (SELECT id FROM refresh_jobs WHERE status IN ('queued','running')))`
  ).bind(jobId, accountId, jobId).run();
  return (res.meta && res.meta.changes) > 0;
}

export async function releaseAccounts(db, jobId) {
  await db.prepare('UPDATE social_accounts SET active_job_id = NULL WHERE active_job_id = ?').bind(jobId).run();
}

/* ─────────────────────────── the chunk runner ─────────────────────────── */

/**
 * Runs as much of a job as fits in one invocation's external-call budget.
 *
 * Returns { done, calls, enqueue } -- `enqueue` true means the caller should
 * put a continuation message on the queue. Enqueueing is left to the caller so
 * this stays a pure state machine that tests can drive without a queue binding.
 */
export async function runChunk(db, env, jobId, { adapters = null } = {}) {
  const job = await getJob(db, jobId);
  if (!job) return { error: 'Job not found', done: true };
  if (!ACTIVE.includes(job.status)) return { done: true, alreadyFinished: true };

  let pending = JSON.parse(job.pending_json || '[]');
  const stats = {
    fetched: job.clips_fetched, failed: job.clips_failed,
    skipped: job.clips_skipped, imported: job.imported
  };
  const acctStats = JSON.parse(job.accounts_json || '{}');

  await db.prepare(
    "UPDATE refresh_jobs SET status = 'running', invocations = invocations + 1, updated_at = ? WHERE id = ?"
  ).bind(Date.now(), jobId).run();

  const accountCache = new Map();
  const counters = new Map();
  let calls = 0;
  let blockedThisRound = false;
  // Accounts already pushed to the back of the queue this invocation, so the
  // loop can tell "try the next account" from "we have cycled the whole list".
  const deferredAccounts = new Set();

  while (pending.length) {
    const item = pending[0];
    const cost = ITEM_COST[item.t] || 1;
    if (calls + cost > CALLS_PER_INVOCATION) break;   // hand off, item untouched

    const account = await loadAccount(db, item.a, accountCache);

    // An account that vanished or was disconnected mid-job: drop its work
    // rather than failing it, since there is nothing wrong with the clips.
    if (!account || account.status !== 'connected' || !account.access_token) {
      pending.shift();
      stats.skipped += countClips(item);
      continue;
    }

    // Already deferred this account once this invocation, and it is back at
    // the head: every account still queued is blocked, so there is nothing
    // left to make progress on. Without this the deferral cycles forever --
    // with two blocked accounts, moving each to the end just swaps which one
    // is in front, and the invocation spins until the platform kills it.
    if (deferredAccounts.has(String(item.a))) break;

    if (!(await claimAccount(db, item.a, jobId))) {
      // Another live job holds this account. Move its items to the END rather
      // than dropping or blocking on them, so the rest of this job still makes
      // progress and these get retried on a later invocation.
      deferredAccounts.add(String(item.a));
      const deferred = [];
      pending = pending.filter(x => (String(x.a) === String(item.a) ? (deferred.push(x), false) : true));
      pending = pending.concat(deferred);
      blockedThisRound = true;
      continue;
    }

    if (!counters.has(item.a)) counters.set(item.a, makeCallCounter(item.a));
    const counter = counters.get(item.a);
    const before = counter.count();

    const acctKey = String(item.a);
    acctStats[acctKey] = acctStats[acctKey] || { label: account.username, platform: account.platform, total: 0, done: 0 };
    acctStats[acctKey].state = 'working';

    try {
      if (item.t === 'import') {
        stats.imported += await runImport(db, env, account, counter, adapters);
      } else {
        const r = await runViews(db, env, account, item, counter, adapters);
        stats.fetched += r.ok;
        stats.failed += r.failed;
        stats.skipped += r.skipped;
        acctStats[acctKey].done += r.ok + r.failed + r.skipped;
      }
    } catch (e) {
      // One item's failure never halts the chain -- same isolation principle
      // the per-clip sync already follows.
      stats.failed += countClips(item);
      recordAccountError(acctStats, item.a, account, e);
    }

    calls += Math.max(counter.count() - before, cost === ITEM_COST.import ? 0 : cost);
    pending.shift();
  }

  // Persist every counter's calls to the shared ledger so the budget the UI
  // shows reflects what this job actually spent.
  for (const c of counters.values()) await c.flush(db);
  for (const [accountId] of counters) {
    await updateAccountBudget(db, acctStats, accountId, accountCache);
  }

  // An account is finished when nothing of its work is left in the queue.
  // Errors are sticky so a failure is not overwritten by a later 'done'.
  const stillQueued = new Set(pending.map(x => String(x.a)));
  for (const [key, st] of Object.entries(acctStats)) {
    if (st.error) { st.state = 'error'; continue; }
    st.state = stillQueued.has(key) ? (st.done > 0 ? 'working' : 'waiting') : 'done';
  }

  const finished = pending.length === 0;
  const ts = Date.now();

  await db.prepare(
    `UPDATE refresh_jobs SET pending_json = ?, clips_fetched = ?, clips_failed = ?,
       clips_skipped = ?, imported = ?, accounts_json = ?, status = ?, updated_at = ?,
       finished_at = ? WHERE id = ?`
  ).bind(
    JSON.stringify(pending), stats.fetched, stats.failed, stats.skipped, stats.imported,
    JSON.stringify(acctStats), finished ? 'done' : 'running', ts, finished ? ts : null, jobId
  ).run();

  if (finished) await releaseAccounts(db, jobId);

  return {
    done: finished,
    calls,
    remaining: pending.length,
    blocked: blockedThisRound,
    enqueue: !finished,
    stats
  };
}

/**
 * Runs one chunk and, if work remains, puts a continuation on the queue.
 *
 * Kept separate from runChunk so the engine itself stays a pure state machine
 * that tests can drive with no queue binding present.
 *
 * When a job finishes, every non-completed campaign is re-allocated. That is
 * pure D1 work with no external calls, so it costs nothing against the
 * subrequest budget this whole design exists to respect -- and running it for
 * all campaigns rather than tracking which ones a job touched removes a whole
 * class of "we forgot to reprice that one" bug for no meaningful cost.
 */
export async function advanceJob(db, env, jobId, opts = {}) {
  const r = await runChunk(db, env, jobId, opts);

  if (r.enqueue && env && env.REFRESH_QUEUE) {
    await env.REFRESH_QUEUE.send({ jobId });
  }

  if (r.done && !r.alreadyFinished && !r.error && typeof opts.onFinish === 'function') {
    await opts.onFinish(jobId);
  }
  return r;
}

/** Shape the progress panel polls. Budget figures are read live, never cached. */
export function publicJob(row) {
  if (!row) return null;
  let pendingCount = 0;
  try { pendingCount = JSON.parse(row.pending_json || '[]').length; } catch { pendingCount = 0; }

  const done = row.clips_fetched + row.clips_failed + row.clips_skipped;
  return {
    id: row.id,
    kind: row.kind,
    clipper_id: row.clipper_id,
    triggered_by: row.triggered_by,
    status: row.status,
    invocations: row.invocations,
    clips_fetched: row.clips_fetched,
    clips_failed: row.clips_failed,
    clips_skipped: row.clips_skipped,
    imported: row.imported,
    remaining: pendingCount,
    total: done + pendingCount,
    accounts: JSON.parse(row.accounts_json || '{}'),
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
    // A job whose status says 'running' but which has not moved in this long
    // has almost certainly lost its invocation outright (Queues retries a
    // failed consumer, but an invocation killed mid-write leaves no trace).
    stalled: row.status === 'running' && (Date.now() - row.updated_at) > STALL_AFTER_MS
  };
}

export const STALL_AFTER_MS = 10 * 60 * 1000;

/** Puts a stalled or failed job back on the queue, resuming from pending_json. */
export async function retryJob(db, env, jobId) {
  const job = await getJob(db, jobId);
  if (!job) return { error: 'Job not found', status: 404 };
  if (job.status === 'done') return { error: 'That refresh already finished.', status: 400 };

  await db.prepare("UPDATE refresh_jobs SET status = 'queued', error = NULL, updated_at = ? WHERE id = ?")
    .bind(Date.now(), jobId).run();
  if (env && env.REFRESH_QUEUE) await env.REFRESH_QUEUE.send({ jobId });
  return { ok: true, job_id: jobId };
}

/* ─────────────────────────── item handlers ─────────────────────────── */

async function loadAccount(db, accountId, cache) {
  if (cache.has(accountId)) return cache.get(accountId);
  // Carries the campaign this account works for, which a plain social_accounts
  // row does not have. Importing a clip needs campaign_id (NOT NULL) and the
  // campaign's allowed_platforms; without them the INSERT bound campaign_id to
  // NULL and INSERT OR IGNORE discarded the row without raising, so an import
  // reported success while writing nothing.
  const row = await db.prepare(
    `SELECT a.*, a.id AS account_id,
            p.campaign_id, p.id AS participation_id, p.status AS part_status, c.allowed_platforms
     FROM social_accounts a
     LEFT JOIN participation_accounts pa ON pa.account_id = a.id
     LEFT JOIN participations p ON p.id = pa.participation_id AND p.status IN ('active', 'paused')
     LEFT JOIN campaigns c ON c.id = p.campaign_id
     WHERE a.id = ?
     ORDER BY pa.linked_at DESC
     LIMIT 1`
  ).bind(accountId).first();
  cache.set(accountId, row);
  return row;
}

function countClips(item) {
  if (item.t === 'yt_views') return (item.s || []).length;
  if (item.t === 'ig_view') return 1;
  return 0;
}

async function runImport(db, env, account, counter, adapters) {
  const adapter = (adapters && adapters[account.platform]) || getAdapter(account.platform);

  const { results: existing } = await db.prepare(
    'SELECT ig_media_id FROM submissions WHERE platform = ? AND account_id = ?'
  ).bind(account.platform, account.id).all();
  const knownIds = new Set((existing || []).map(r => String(r.ig_media_id)));

  // withAccount, not a bare adapter call. Google access tokens last about an
  // hour, so a stored token is very often already stale by the time a job
  // reaches this account -- calling the adapter directly reports TOKEN_EXPIRED
  // for every YouTube account instead of just renewing and continuing.
  const media = await withAccount(db, env, account, (acct) =>
    adapter.listRecent(
      acct,
      { sinceTs: account.connected_at || 0, knownIds, onAttempt: counter.onAttempt },
      env
    )
  );

  // A campaign only accepts the platforms it was configured for, so a clip can
  // never arrive on a platform the brand did not agree to.
  if (!account.campaign_id) return 0;
  if (!campaignPlatforms(account).includes(account.platform)) return 0;

  // Actually record what was found. This is the whole point of the import leg:
  // listing the media and returning a count -- which is all this did after the
  // chained-refresh refactor deleted the old autoImportClips -- meant every
  // auto-import account silently stopped gaining clips, while the refresh panel
  // still reported "N new videos found" from the discarded array and the
  // campaign page still promised "new Reels are added automatically".
  //
  // It also fed a second failure: knownIds is built from submissions, so with
  // nothing ever written the dedup set stayed empty and every run re-probed the
  // channel's entire history.
  let imported = 0;
  for (const m of media || []) {
    // knownIds covers this account; this catches the same media arriving under
    // a different account, which the per-account set cannot see.
    const seen = await db.prepare(
      'SELECT id FROM submissions WHERE platform = ? AND ig_media_id = ?'
    ).bind(account.platform, m.external_id).first();
    if (seen) continue;

    const res = await db.prepare(
      `INSERT OR IGNORE INTO submissions
         (clipper_id, campaign_id, account_id, platform, ig_media_id, permalink, views, earning, status,
          media_product_type, thumbnail_url, posted_at, created_at, source,
          duration_seconds, is_short, eligible)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'active', ?, ?, ?, ?, 'auto', ?, ?, ?)`
    ).bind(
      account.clipper_id, account.campaign_id, account.account_id, account.platform,
      m.external_id, m.permalink || '',
      m.media_type || null, m.thumbnail_url || null,
      m.posted_at || Date.now(), Date.now(),
      m.duration_seconds == null ? null : m.duration_seconds,
      m.is_short == null ? null : (m.is_short ? 1 : 0),
      m.eligible === false ? 0 : 1
    ).run();
    // Count what was actually written, not what was attempted. INSERT OR IGNORE
    // discards a row that violates a constraint without raising, so incrementing
    // unconditionally would report an import that did not happen -- the same
    // 'success for work not done' this whole fix exists to remove.
    if (res && res.meta && res.meta.changes) imported++;
  }
  return imported;
}

/**
 * Fetches and writes views for one item.
 *
 * Every write re-checks `locked_at IS NULL` at WRITE time, not just when the
 * work list was built. A job's list is a snapshot, and a clip can be paid and
 * locked between the snapshot and its turn -- writing to it then would violate
 * the rule that a settled clip is frozen history, which is the single most
 * load-bearing guarantee in the payout system.
 */
async function runViews(db, env, account, item, counter, adapters) {
  const adapter = (adapters && adapters[account.platform]) || getAdapter(account.platform);
  const ids = item.t === 'yt_views' ? item.m : [item.m];
  const subIds = item.t === 'yt_views' ? item.s : [item.s];

  // Same token-renewal wrapper as the import path above.
  const results = await withAccount(db, env, account, (acct) =>
    adapter.fetchViews(acct, ids, env, { onAttempt: counter.onAttempt })
  );

  const now = Date.now();
  let ok = 0, failed = 0, skipped = 0;

  for (let i = 0; i < ids.length; i++) {
    const r = results && results.get ? results.get(ids[i]) : null;
    const subId = subIds[i];

    if (r == null) {
      const changed = await writeGuarded(db,
        'UPDATE submissions SET sync_error = ?, last_synced_at = ? WHERE id = ? AND locked_at IS NULL',
        ['MEDIA_NOT_FOUND', now, subId]);
      changed ? failed++ : skipped++;
      continue;
    }
    if (!r.ok) {
      const changed = await writeGuarded(db,
        'UPDATE submissions SET sync_error = ?, last_synced_at = ? WHERE id = ? AND locked_at IS NULL',
        [r.code, now, subId]);
      changed ? failed++ : skipped++;
      continue;
    }
    const changed = await writeGuarded(db,
      'UPDATE submissions SET views = ?, last_synced_at = ?, last_ok_sync_at = ?, sync_error = NULL WHERE id = ? AND locked_at IS NULL',
      [r.views, now, now, subId]);
    changed ? ok++ : skipped++;
  }

  return { ok, failed, skipped };
}

async function writeGuarded(db, sql, args) {
  const res = await db.prepare(sql).bind(...args).run();
  return (res.meta && res.meta.changes) > 0;
}

function recordAccountError(acctStats, accountId, account, e) {
  const key = String(accountId);
  acctStats[key] = acctStats[key] || {};
  acctStats[key].platform = account.platform;
  acctStats[key].label = account.username;
  acctStats[key].error = (e && e.code) || 'UNKNOWN';
}

async function updateAccountBudget(db, acctStats, accountId, cache) {
  const account = cache.get(accountId);
  const key = String(accountId);
  acctStats[key] = acctStats[key] || {};
  acctStats[key].platform = account ? account.platform : null;
  acctStats[key].label = account ? account.username : null;
  if (account && account.platform === 'instagram') {
    const b = await getBudget(db, accountId);
    acctStats[key].used = b.used;
    acctStats[key].remaining = b.remaining;
    acctStats[key].limit = b.limit;
    acctStats[key].reset_in_ms = b.reset_in_ms;
  }
}
