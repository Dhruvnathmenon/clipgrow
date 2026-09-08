import { json, err, readJson, matchPath } from '../http.js';
import { createSessionCookie, requireAdmin, hashPassword, clearCookieHeader } from '../auth.js';
import {
  now, publicClipper, publicAccount, publicCampaign, pickBlueprint,
  campaignSpend, campaignWithSpend, clipperFinancials, getCampaignById, normalizeUsername, defaultDisplayName, slugify,
  disconnectSocialAccount, SPEND_EXPR, totalOutstanding, accountIssues,
  normaliseUpiId, validateUpiId,
  normaliseContactNumber, validateContactNumber, normaliseEmail, validateEmail,
  normaliseDiscordId, validateDiscordId,
  ACTIVE_WINDOW_MS, pendingClipperExpr
} from '../db.js';
import { reallocateCampaign, reallocateAll } from '../earnings.js';
import { createRefreshJob, advanceJob, getJob, publicJob, retryJob, cancelJob, listJobs, STALL_AFTER_MS } from '../refresh-jobs.js';
import { jobEvents, jobFailureSummary } from '../refresh-events.js';
import {
  walletBalances, walletOfKind, agencyAvailable, recordClientPayment, topUpCampaignBudget,
  campaignFinancials, allCampaignFinancials, campaignFunding, fundingAlerts,
  agencyPnL, addEntry, voidEntry, listEntries, LEDGER_CATEGORIES
} from '../finance.js';
import { parseBlueprintDocx } from '../blueprint.js';
import { payableClips, settlePayment, reversePayment, writeOffAllBelowMin } from '../payouts.js';
import { exportClipsCsv, exportPaymentsCsv } from '../export.js';
import { PLATFORMS, campaignPlatforms, configuredPlatforms } from '../platforms.js';
import { debugMediaInsights, debugListMedia, fetchMediaViews } from '../instagram.js';
import { makeCallCounter } from '../rate-budget.js';
import { logAction, listAuditLog } from '../audit.js';
import {
  reviewQueue, reviewedList, reviewCountsToday, submitReview, clipperQuality, moderatorActivity
} from '../reviews.js';
import { TERMINAL_SYNC_ERRORS } from '../clipstate.js';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const CAMPAIGN_STATUSES = ['active', 'budget_full', 'completed'];
const PART_STATUSES = ['active', 'paused', 'kicked'];
// Static, hardcoded error codes -- safe to inline into SQL text directly
// rather than as bound parameters, and it lets every NOT IN (...) below
// read from the one list in clipstate.js instead of repeating the tuple.
const TERMINAL_SYNC_ERRORS_SQL = TERMINAL_SYNC_ERRORS.map(c => `'${c}'`).join(', ');
// A submission the admin has personally acknowledged (migration 029) is
// suppressed the same way a terminal sync_error is -- until sync_error
// actually changes, at which point this stops matching and the count
// reopens on its own. Shared so the Overview counts and any per-campaign
// count agree with the acknowledge/unflag action in admin.html.
const NOT_ACKNOWLEDGED_SQL = '(sync_error_acknowledged_as IS NULL OR sync_error_acknowledged_as != sync_error)';

/**
 * Sanitises the platform list for a campaign. Falls back to Instagram when the
 * input is empty or unrecognised, so a bad value can never silently open a
 * campaign to a platform the brand did not agree to.
 */
/**
 * A numeric field from a PATCH body, falling back only when the value is
 * absent or unusable. Distinguishes a deliberate 0 from "not provided", which
 * `Number(x) || fallback` cannot do, and rejects negatives so a stray minus
 * cannot quietly invert a campaign's economics.
 */
function numOr(value, fallback) {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function normalisePlatforms(input) {
  const list = (Array.isArray(input) ? input : String(input || '').split(','))
    .map(s => String(s).trim().toLowerCase())
    .filter(p => PLATFORMS.includes(p));
  return ([...new Set(list)].join(',')) || 'instagram';
}

export async function handleAdmin(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/admin/login' && method === 'POST') {
    const { password } = await readJson(request);
    if (!password || !env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) return err('Incorrect password', 401);
    const cookie = await createSessionCookie('admin', 'admin', env.SESSION_SECRET);
    return json({ ok: true }, 200, { 'Set-Cookie': cookie });
  }

  if (pathname === '/api/admin/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookieHeader('cg_session') });
  }

  if (!pathname.startsWith('/api/admin/')) return null;

  const session = await requireAdmin(request, env);
  if (!session) return err('Unauthorized', 401);

  // ------------------------------------------------------------- overview
  if (pathname === '/api/admin/overview' && method === 'GET') {
    // A single sync_error is normal noise -- a transient rate limit clears on
    // the next 6-hourly cycle. What actually needs a human is a clip that has
    // gone TWO cycles (12h+) without a single successful sync despite
    // presumably being retried each time: that is a genuinely stuck clip, not
    // a blip, and this is the number that would have surfaced the batch-
    // isolation bug immediately instead of only being found by hand.
    const STUCK_AFTER_MS = 12 * 60 * 60 * 1000;
    const s = await env.DB.prepare(
      `SELECT
        -- Registered + enabled clipper accounts. Anyone can join a campaign
        -- with one click, so this alone says nothing about who is actually
        -- doing the work -- see active_clippers below for that.
        (SELECT COUNT(*) FROM clippers WHERE status='active') AS joined_clippers,
        -- Clippers who have actually posted (real platform post date, never
        -- import time) within ACTIVE_WINDOW_MS. Distinct, so a clipper active
        -- across several campaigns still counts once here.
        (SELECT COUNT(DISTINCT s2.clipper_id) FROM submissions s2
           JOIN clippers cl2 ON cl2.id = s2.clipper_id
          WHERE s2.status = 'active' AND cl2.status = 'active'
            AND COALESCE(s2.posted_at, s2.created_at) >= ?) AS active_clippers,
        (SELECT COUNT(*) FROM campaigns WHERE status='active') AS active_campaigns,
        -- The whole-history number, across every clip in every status. A
        -- clip past its 7-day tracking window (clipstate.js's
        -- TRACKING_WINDOW_MS) has already stopped syncing, so its views
        -- column IS its final count -- this SUM needs no separate
        -- bookkeeping to reflect that.
        (SELECT COALESCE(SUM(views),0) FROM submissions) AS total_views,
        (SELECT ${SPEND_EXPR} FROM submissions) AS total_earned,
        (SELECT COALESCE(SUM(amount),0) FROM payments) AS total_paid,
        -- outstanding is computed separately by totalOutstanding()
        -- in db.js, beside the per-clipper rule it must agree with.
        (SELECT COUNT(*) FROM social_accounts WHERE status='needs_reauth') AS accounts_needing_reauth,
        -- Accounts whose last auto-import attempt failed for a non-auth
        -- reason. These still read as 'connected' and their existing clips
        -- keep syncing fine, so the ONLY symptom is new uploads silently not
        -- arriving -- invisible until a clipper complains. Surfaced here so
        -- an absence is something the dashboard can actually report.
        (SELECT COUNT(*) FROM social_accounts
           WHERE status='connected' AND last_error_code LIKE 'IMPORT!_%' ESCAPE '!') AS accounts_import_failing,
        -- Excludes the same permanent conditions as submissions_stuck below,
        -- for the same reason: a permanently-dead post is not "a transient
        -- error expected to clear on the next sync" (the FYI line's own
        -- wording), and it is already explained to the clipper on their own
        -- dashboard, so it needs no admin attention on either line here.
        (SELECT COUNT(*) FROM submissions
           WHERE sync_error IS NOT NULL AND status='active'
             AND sync_error NOT IN (${TERMINAL_SYNC_ERRORS_SQL})
             AND ${NOT_ACKNOWLEDGED_SQL}) AS submissions_with_errors,
        (SELECT COUNT(*) FROM submissions
           WHERE sync_error IS NOT NULL AND status='active' AND locked_at IS NULL
             -- A clip that has never had a successful sync has no
             -- last_ok_sync_at to measure "12h+ stuck" from. The old
             -- last_ok_sync_at IS NULL branch flagged one immediately
             -- regardless of age, so a clip's very first failed attempt,
             -- seconds old, read as "stuck 12+ hours". Falling back to
             -- created_at measures from when tracking actually began.
             AND COALESCE(last_ok_sync_at, created_at) < ?
             -- MEDIA_NOT_FOUND and PRE_CONVERSION_MEDIA are permanent, not
             -- stuck: nothing will ever make a deleted post or a pre-conversion
             -- post sync successfully, so counting them here meant the banner
             -- flagged the same clips forever with no action anyone could take.
             -- clipstate.js already gives both their own explained, final state
             -- ('removed' / 'no_insights') on the clipper's own dashboard.
             AND sync_error NOT IN (${TERMINAL_SYNC_ERRORS_SQL})
             AND ${NOT_ACKNOWLEDGED_SQL}) AS submissions_stuck`
    ).bind(Date.now() - ACTIVE_WINDOW_MS, Date.now() - STUCK_AFTER_MS).first();

    // The counts above say something is wrong; these say WHICH account, so the
    // banner can name it. A count alone means opening every clipper in turn to
    // find the one that needs attention. Fetches every candidate row and
    // filters with accountIssues() -- the exact same open/acknowledged logic
    // the Issues panel already uses -- rather than re-deriving the
    // acknowledgment check in SQL a second time and risking the two drifting
    // apart (this banner used to skip the ack check entirely, so unflagging
    // an account elsewhere never made it stop showing up here).
    const { results: problemCandidates } = await env.DB.prepare(
      `SELECT a.id, a.platform, a.username, a.status, a.last_error_code, a.last_error_at, a.error_acknowledged_at,
              COALESCE(cl.display_name, cl.username) AS clipper, cl.contact_number, cl.discord_id
       FROM social_accounts a JOIN clippers cl ON cl.id = a.clipper_id
       WHERE a.status = 'needs_reauth'
          OR (a.status = 'connected' AND a.last_error_code LIKE 'IMPORT!_%' ESCAPE '!')
       ORDER BY a.platform, cl.username`
    ).all();
    const problemAccounts = (problemCandidates || []).filter(a => accountIssues(a).errorOpen);

    // Stuck clips grouped by account: five clips stuck on one account is one
    // problem to go and look at, not five.
    const { results: stuckAccounts } = await env.DB.prepare(
      `SELECT a.platform, a.username, COALESCE(cl.display_name, cl.username) AS clipper,
              COUNT(*) AS clips, MIN(COALESCE(s.last_ok_sync_at, s.created_at)) AS oldest
       FROM submissions s
       JOIN clippers cl ON cl.id = s.clipper_id
       LEFT JOIN social_accounts a ON a.id = s.account_id
       WHERE s.sync_error IS NOT NULL AND s.status = 'active' AND s.locked_at IS NULL
         AND COALESCE(s.last_ok_sync_at, s.created_at) < ?
             -- MEDIA_NOT_FOUND and PRE_CONVERSION_MEDIA are permanent, not
             -- stuck: nothing will ever make a deleted post or a pre-conversion
             -- post sync successfully, so counting them here meant the banner
             -- flagged the same clips forever with no action anyone could take.
             -- clipstate.js already gives both their own explained, final state
             -- ('removed' / 'no_insights') on the clipper's own dashboard.
             AND sync_error NOT IN (${TERMINAL_SYNC_ERRORS_SQL})
             AND ${NOT_ACKNOWLEDGED_SQL}
       GROUP BY s.account_id
       ORDER BY clips DESC`
    ).bind(Date.now() - STUCK_AFTER_MS).all();

    // The FYI line's transient errors, named the same way stuckAccounts
    // above names the urgent ones -- "4 video(s) hit a transient sync
    // error" with no way to see which ones was the actual complaint: it
    // read as if it might need attention with nothing to check. Same query
    // shape as stuckAccounts, flipped to the NOT-yet-12h+ side of the same
    // cutoff, so between the two lists every submissions_with_errors row is
    // accounted for exactly once.
    const { results: transientErrors } = await env.DB.prepare(
      `SELECT a.platform, a.username, COALESCE(cl.display_name, cl.username) AS clipper,
              COUNT(*) AS clips
       FROM submissions s
       JOIN clippers cl ON cl.id = s.clipper_id
       LEFT JOIN social_accounts a ON a.id = s.account_id
       WHERE s.sync_error IS NOT NULL AND s.status = 'active' AND s.locked_at IS NULL
         AND COALESCE(s.last_ok_sync_at, s.created_at) >= ?
             AND sync_error NOT IN (${TERMINAL_SYNC_ERRORS_SQL})
             AND ${NOT_ACKNOWLEDGED_SQL}
       GROUP BY s.account_id
       ORDER BY clips DESC`
    ).bind(Date.now() - STUCK_AFTER_MS).all();

    // A wedged refresh job is otherwise invisible: publicJob only computes
    // `stalled` when someone polls that specific job id, and there is no job
    // list. Meanwhile it blocks every subsequent sync.
    const { results: stalledJobs } = await env.DB.prepare(
      `SELECT id, kind, clipper_id, triggered_by, updated_at
         FROM refresh_jobs
        WHERE status IN ('queued','running') AND updated_at < ?
        ORDER BY updated_at ASC`
    ).bind(Date.now() - STALL_AFTER_MS).all();

    return json({
      overview: { ...s, outstanding: await totalOutstanding(env.DB) },
      problem_accounts: problemAccounts || [],
      stuck_accounts: stuckAccounts || [],
      transient_errors: transientErrors || [],
      stalled_jobs: stalledJobs || []
    });
  }

  // ----------------------------------------------------------- finance
  //
  // Everything else in this file answers "what do we owe clippers". These
  // answer "have we been paid, what did we spend and why, are we cash
  // positive, and what does the agency owe its founders".

  if (pathname === '/api/admin/finance/overview' && method === 'GET') {
    return json({
      totals: await agencyPnL(env.DB),
      wallets: await walletBalances(env.DB),
      // Campaigns delivering faster than the client is paying. This is the
      // number that decides whether Sunday's payout run can happen.
      funding_alerts: await fundingAlerts(env.DB),
      available: await agencyAvailable(env.DB),
      categories: LEDGER_CATEGORIES
    });
  }

  if (pathname === '/api/admin/finance/campaigns' && method === 'GET') {
    return json({ campaigns: await allCampaignFinancials(env.DB) });
  }

  let params = matchPath('/api/admin/finance/campaigns/:id', pathname);
  if (params && method === 'GET') {
    const fin = await campaignFinancials(env.DB, Number(params.id));
    if (!fin) return err('Not found', 404);
    return json({ campaign: fin, funding: await campaignFunding(env.DB, Number(params.id)) });
  }

  if (pathname === '/api/admin/finance/entries' && method === 'GET') {
    const q = url.searchParams;
    const numOrNull = (k) => (q.get(k) ? Number(q.get(k)) : null);
    return json({
      entries: await listEntries(env.DB, {
        walletId: numOrNull('wallet_id'),
        category: q.get('category') || null,
        campaignId: numOrNull('campaign_id'),
        clientId: numOrNull('client_id'),
        from: numOrNull('from'),
        to: numOrNull('to'),
        includeVoid: q.get('include_void') === '1',
        limit: Math.min(1000, Number(q.get('limit')) || 200)
      })
    });
  }

  if (pathname === '/api/admin/finance/entries' && method === 'POST') {
    const body = await readJson(request);
    const r = await addEntry(env.DB, { ...body, created_by: 'admin' });
    if (r.error) return err(r.error, r.status || 400);
    return json(r, 201);
  }

  // A client payment is never one entry: it splits into the clipper share and
  // our fee on arrival, so which rupees are whose is never a later guess.
  if (pathname === '/api/admin/finance/client-payment' && method === 'POST') {
    const body = await readJson(request);
    const r = await recordClientPayment(env.DB, {
      clientId: body.client_id ? Number(body.client_id) : null,
      campaignId: body.campaign_id ? Number(body.campaign_id) : null,
      amount: body.amount,
      feePercent: body.fee_percent != null ? Number(body.fee_percent) : 20,
      method: body.method, reference: body.reference, note: body.note,
      occurredAt: body.occurred_at || null, createdBy: 'admin'
    });
    if (r.error) return err(r.error, r.status || 400);
    return json(r, 201);
  }

  params = matchPath('/api/admin/finance/entries/:id/void', pathname);
  if (params && method === 'POST') {
    const body = await readJson(request);
    const r = await voidEntry(env.DB, Number(params.id), body.reason);
    if (r.error) return err(r.error, r.status || 400);
    return json(r);
  }

  if (pathname === '/api/admin/finance/funding' && method === 'GET') {
    return json({ alerts: await fundingAlerts(env.DB) });
  }

  // ------------------------------------------------------- blueprint parse
  if (pathname === '/api/admin/campaigns/parse' && method === 'POST') {
    let form;
    try {
      form = await request.formData();
    } catch {
      return err('Expected a file upload');
    }
    const file = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') return err('No file received');
    if (file.size > MAX_UPLOAD_BYTES) return err('File is too large (max 5MB)');
    if (!/\.docx$/i.test(file.name || '')) return err('Please upload a Word .docx blueprint');
    try {
      const draft = await parseBlueprintDocx(await file.arrayBuffer());
      return json({ draft, source_filename: file.name });
    } catch (e) {
      return err(`Could not read that blueprint: ${e.message}`, 422);
    }
  }

  // -------------------------------------------------------------- clippers
  if (pathname === '/api/admin/clippers' && method === 'GET') {
    // Deleted clippers are archived, not gone (see the DELETE handler below),
    // so they stay out of the main roster by default and only show up when
    // explicitly asked for -- the admin UI's separate "Deleted" section.
    const wantDeleted = url.searchParams.get('status') === 'deleted';
    const { results } = await env.DB.prepare(
      wantDeleted
        ? "SELECT * FROM clippers WHERE status = 'deleted' ORDER BY created_at DESC"
        : "SELECT * FROM clippers WHERE status != 'deleted' ORDER BY created_at DESC"
    ).all();
    const out = [];
    for (const c of results || []) {
      const money = await clipperFinancials(env.DB, c.id);
      // Same open-issue definition as the bucketed Issues panel (accountIssues()
      // in db.js) -- this used to be its own raw SQL check with no idea the
      // acknowledgment columns existed, so unflagging something below never
      // cleared the badge shown here.
      const { results: accts } = await env.DB.prepare(
        `SELECT a.status, a.username, a.last_error_code, a.last_error_at,
                a.mismatch_acknowledged_as, a.error_acknowledged_at,
                (SELECT COALESCE(tr.identifier, tr.ig_username) FROM tester_requests tr
                   JOIN participation_accounts pa ON pa.account_id = a.id
                   JOIN participations p ON p.id = pa.participation_id AND p.campaign_id = tr.campaign_id
                   WHERE tr.clipper_id = a.clipper_id AND tr.platform = a.platform AND tr.status = 'confirmed'
                     AND COALESCE(tr.identifier, tr.ig_username) != a.username
                   LIMIT 1) AS mismatch_approved_as
         FROM social_accounts a WHERE clipper_id = ?`).bind(c.id).all();
      const acc = { n: (accts || []).length, bad: 0, mismatched: 0 };
      for (const a of accts || []) {
        const { mismatchOpen, errorOpen } = accountIssues(a);
        if (errorOpen) acc.bad++;
        if (mismatchOpen) acc.mismatched++;
      }
      const parts = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM participations WHERE clipper_id = ? AND status != 'kicked'").bind(c.id).first();
      out.push({
        ...publicClipper(c), money, accounts: acc.n, accounts_unhealthy: acc.bad || 0,
        accounts_mismatched: acc.mismatched || 0, campaigns: parts.n,
        quality: await clipperQuality(env.DB, c.id),
        // Admin-only -- deliberately not part of publicClipper() (shared with
        // moderator.js's roster), see migration 028's comment.
        upi_id: c.upi_id || null, upi_account_name: c.upi_account_name || null,
        // Same admin-only boundary, migration 030.
        contact_number: c.contact_number || null, email: c.email || null, legal_name: c.legal_name || null,
        // Fallback contact channel, migration 035 -- same boundary again.
        discord_id: c.discord_id || null
      });
    }
    return json({ clippers: out });
  }

  if (pathname === '/api/admin/clippers' && method === 'POST') {
    const { username, password } = await readJson(request);
    if (!username || !password) return err('Username and password are required');
    if (String(password).length < 6) return err('Password must be at least 6 characters');
    const clean = normalizeUsername(username);
    if (!clean) return err('Username cannot be blank');
    const existing = await env.DB
      .prepare('SELECT id FROM clippers WHERE username = ? COLLATE NOCASE').bind(clean).first();
    if (existing) return err('That username is already taken', 409);
    const { hash, salt } = await hashPassword(password);
    // Display name is always the username, capitalised -- the gold standard,
    // not a free-text field. Rename it later through Edit if it ever needs
    // to differ.
    const res = await env.DB.prepare(
      `INSERT INTO clippers (username, password_hash, password_salt, display_name, status, created_at, created_by_type, created_by_name)
       VALUES (?, ?, ?, ?, ?, ?, 'admin', 'Admin')`
    ).bind(clean, hash, salt, defaultDisplayName(clean), 'active', now()).run();
    await logAction(env.DB, {
      staffType: 'admin', staffName: 'Admin', action: 'clipper_created',
      targetType: 'clipper', targetId: res.meta.last_row_id, targetLabel: clean
    });
    return json({ ok: true, id: res.meta.last_row_id, username: clean }, 201);
  }

  // ---------------------------------------------------------- moderators
  //
  // Individual named staff logins (migration 023) -- not a shared password
  // like ADMIN_PASSWORD -- so each moderator can be told apart, disabled,
  // and re-passworded independently. Only the admin ever writes here; a
  // moderator session (src/routes/moderator.js) has no route that touches
  // this table, so moderators can never create or manage each other.
  if (pathname === '/api/admin/moderators' && method === 'GET') {
    // Includes the synthetic admin row (id: null) -- the Video Review tab's
    // per-reviewer breakdown wants admin alongside every moderator in one
    // uniform list. The Moderators management table filters that row out
    // client-side, since Disable/Reset Pass make no sense for it.
    return json({ moderators: await moderatorActivity(env.DB) });
  }

  if (pathname === '/api/admin/moderators' && method === 'POST') {
    const { username, password } = await readJson(request);
    if (!username || !password) return err('Username and password are required');
    if (String(password).length < 6) return err('Password must be at least 6 characters');
    const clean = normalizeUsername(username);
    if (!clean) return err('Username cannot be blank');
    const existing = await env.DB
      .prepare('SELECT id FROM moderators WHERE username = ? COLLATE NOCASE').bind(clean).first();
    if (existing) return err('That username is already taken', 409);
    const { hash, salt } = await hashPassword(password);
    const res = await env.DB.prepare(
      'INSERT INTO moderators (username, password_hash, password_salt, display_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(clean, hash, salt, defaultDisplayName(clean), 'active', now()).run();
    return json({ ok: true, id: res.meta.last_row_id, username: clean }, 201);
  }

  params = matchPath('/api/admin/moderators/:id', pathname);
  if (params && method === 'PATCH') {
    const { status, username, display_name, password } = await readJson(request);
    if (status && !['active', 'disabled'].includes(status)) return err('Invalid status');
    const mod = await env.DB.prepare('SELECT id FROM moderators WHERE id = ?').bind(params.id).first();
    if (!mod) return err('Not found', 404);
    if (username != null) {
      const clean = normalizeUsername(username);
      if (!clean) return err('Username cannot be blank');
      const clash = await env.DB.prepare(
        'SELECT id FROM moderators WHERE username = ? COLLATE NOCASE AND id != ?'
      ).bind(clean, params.id).first();
      if (clash) return err('That username is already taken', 409);
      await env.DB.prepare('UPDATE moderators SET username = ? WHERE id = ?').bind(clean, params.id).run();
    }
    if (status) await env.DB.prepare('UPDATE moderators SET status = ? WHERE id = ?').bind(status, params.id).run();
    if (display_name != null) await env.DB.prepare('UPDATE moderators SET display_name = ? WHERE id = ?').bind(display_name, params.id).run();
    if (password) {
      if (String(password).length < 6) return err('Password must be at least 6 characters');
      const { hash, salt } = await hashPassword(password);
      await env.DB.prepare('UPDATE moderators SET password_hash = ?, password_salt = ? WHERE id = ?').bind(hash, salt, params.id).run();
    }
    return json({ ok: true });
  }

  params = matchPath('/api/admin/clippers/:id', pathname);
  if (params && method === 'GET') {
    // Same '|'-delimited "platform:username:status" shape the linked_accounts
    // GROUP_CONCAT below produces -- turned into real objects so the wide
    // clipper detail panel can render a table instead of parsing a string.
    const parseLinkedAccounts = raw => (raw || '').split('|').filter(Boolean).map(part => {
      const i = part.indexOf(':'), j = part.indexOf(':', i + 1);
      return { platform: part.slice(0, i), username: part.slice(i + 1, j) || null, status: part.slice(j + 1) || null };
    });
    const clipper = await env.DB.prepare('SELECT * FROM clippers WHERE id = ?').bind(params.id).first();
    if (!clipper) return err('Not found', 404);
    // mismatch_approved_as: the identifier that was actually approved for a
    // campaign this account is linked to, when it differs from the account
    // that's actually connected. canConnect() never checks this at OAuth time
    // (any confirmed account passes), so it can silently drift -- this is the
    // only place that surfaces it after the fact.
    const { results: accounts } = await env.DB.prepare(
      `SELECT a.*,
         -- What disconnecting this account would actually destroy. The dialog
         -- states these numbers before the admin confirms, rather than a vague
         -- "pending videos are deleted".
         (SELECT COUNT(*) FROM submissions s
            WHERE s.account_id = a.id AND s.locked_at IS NULL) AS unpaid_clips,
         -- What disconnecting destroys: what the CLIPPER would have been
         -- owed on this account's still-pending clips (never the billable
         -- figure -- see src/db.js's pendingClipperExpr).
         (SELECT ${pendingClipperExpr('s')} FROM submissions s WHERE s.account_id = a.id) AS unpaid_value,
         (SELECT COALESCE(tr.identifier, tr.ig_username) FROM tester_requests tr
            JOIN participation_accounts pa ON pa.account_id = a.id
            JOIN participations p ON p.id = pa.participation_id AND p.campaign_id = tr.campaign_id
            WHERE tr.clipper_id = a.clipper_id AND tr.platform = a.platform AND tr.status = 'confirmed'
              AND COALESCE(tr.identifier, tr.ig_username) != a.username
            LIMIT 1) AS mismatch_approved_as,
         -- Which campaign this account is actually plugged into right now, so
         -- the admin doesn't have to cross-reference the Campaigns section
         -- below to see what a connected account is even for.
         (SELECT c.name FROM participation_accounts pa
            JOIN participations p ON p.id = pa.participation_id
            JOIN campaigns c ON c.id = p.campaign_id
            WHERE pa.account_id = a.id LIMIT 1) AS campaign_name
       FROM social_accounts a WHERE a.clipper_id = ?`
    ).bind(params.id).all();
    const { results: parts } = await env.DB.prepare(
      // participations.account_id is the legacy single-account column and is
      // only ever maintained for Instagram, so joining through it shows the
      // Instagram handle and silently hides an attached YouTube channel -- and
      // shows nothing at all for a YouTube-only participation. linked_accounts
      // resolves every platform through participation_accounts, which is the
      // canonical table; the old fields stay for compatibility.
      `SELECT p.*, c.name AS campaign_name, a.username AS account_username, a.status AS account_status,
              (SELECT GROUP_CONCAT(a2.platform || ':' || COALESCE(a2.username,'') || ':' || a2.status, '|')
                 FROM participation_accounts pa JOIN social_accounts a2 ON a2.id = pa.account_id
                 WHERE pa.participation_id = p.id) AS linked_accounts
       FROM participations p JOIN campaigns c ON c.id = p.campaign_id
       LEFT JOIN social_accounts a ON a.id = p.account_id
       WHERE p.clipper_id = ?`).bind(params.id).all();
    const { results: subs } = await env.DB.prepare(
      `SELECT s.*, c.name AS campaign_name FROM submissions s JOIN campaigns c ON c.id = s.campaign_id
       WHERE s.clipper_id = ? ORDER BY s.created_at DESC`).bind(params.id).all();
    const { results: pays } = await env.DB.prepare(
      `SELECT p.*, c.name AS campaign_name FROM payments p LEFT JOIN campaigns c ON c.id = p.campaign_id
       WHERE p.clipper_id = ? ORDER BY p.paid_at DESC`).bind(params.id).all();
    // Staff-only notes (migration 023) -- a moderator can leave these, never
    // the clipper. Read-only here; admin.html has no write form for them,
    // since the founder only asked for moderators to author notes.
    const { results: notes } = await env.DB.prepare(
      'SELECT * FROM clipper_notes WHERE clipper_id = ? ORDER BY created_at DESC').bind(params.id).all();
    return json({
      clipper: {
        ...publicClipper(clipper),
        upi_id: clipper.upi_id || null, upi_account_name: clipper.upi_account_name || null,
        contact_number: clipper.contact_number || null, email: clipper.email || null,
        legal_name: clipper.legal_name || null, discord_id: clipper.discord_id || null,
        created_at: clipper.created_at
      },
      money: await clipperFinancials(env.DB, params.id),
      quality: await clipperQuality(env.DB, params.id),
      // mismatch_approved_as is deliberately not part of publicAccount (shared
      // with the clipper's own dashboard) -- it's admin-only oversight info.
      accounts: (accounts || []).map(a => ({ ...publicAccount(a), mismatch_approved_as: a.mismatch_approved_as || null, campaign_name: a.campaign_name || null })),
      // linked_accounts stays the old '|'-delimited string (existing callers
      // outside this endpoint's own new admin.html panel parse that shape) --
      // linked_accounts_list is the same data as a real array, added
      // alongside it rather than replacing it, so the wider clipper detail
      // panel can render a proper table instead of parsing a delimited string.
      participations: (parts || []).map(p => ({ ...p, linked_accounts_list: parseLinkedAccounts(p.linked_accounts) })),
      submissions: subs || [],
      payments: pays || [],
      notes: notes || []
    });
  }

  if (params && method === 'PATCH') {
    const {
      status, username, display_name, password, upi_id, upi_account_name,
      contact_number, email, legal_name, discord_id
    } = await readJson(request);
    if (status && !['active', 'disabled'].includes(status)) return err('Invalid status');
    // Username stays lowercase no matter what was typed -- same rule as
    // creation, enforced here too so an edit can never drift from it.
    if (username != null) {
      const clean = normalizeUsername(username);
      if (!clean) return err('Username cannot be blank');
      const clash = await env.DB.prepare(
        'SELECT id FROM clippers WHERE username = ? COLLATE NOCASE AND id != ?'
      ).bind(clean, params.id).first();
      if (clash) return err('That username is already taken', 409);
      await env.DB.prepare('UPDATE clippers SET username = ? WHERE id = ?').bind(clean, params.id).run();
    }
    if (status) await env.DB.prepare('UPDATE clippers SET status = ? WHERE id = ?').bind(status, params.id).run();
    if (display_name != null) await env.DB.prepare('UPDATE clippers SET display_name = ? WHERE id = ?').bind(display_name, params.id).run();
    if (password) {
      if (String(password).length < 6) return err('Password must be at least 6 characters');
      const { hash, salt } = await hashPassword(password);
      await env.DB.prepare('UPDATE clippers SET password_hash = ?, password_salt = ? WHERE id = ?').bind(hash, salt, params.id).run();
    }
    // Lets the admin fix a UPI typo (or enter it on a clipper's behalf, e.g.
    // over a call) from the same Edit action -- this is the one write path
    // other than the clipper's own /api/clipper/me/upi, and it validates the
    // same way.
    if (upi_id != null) {
      const invalid = validateUpiId(upi_id);
      if (invalid) return err(invalid);
      await env.DB.prepare('UPDATE clippers SET upi_id = ? WHERE id = ?').bind(normaliseUpiId(upi_id), params.id).run();
    }
    if (upi_account_name != null) {
      const name = String(upi_account_name).trim();
      if (!name) return err('Enter the name on the UPI account');
      await env.DB.prepare('UPDATE clippers SET upi_account_name = ? WHERE id = ?').bind(name, params.id).run();
    }
    // Contact profile (migration 030) -- same "admin can fix it, same
    // validator as the clipper's own self-service endpoint" reasoning as
    // UPI above.
    if (contact_number != null) {
      const invalid = validateContactNumber(contact_number);
      if (invalid) return err(invalid);
      await env.DB.prepare('UPDATE clippers SET contact_number = ? WHERE id = ?')
        .bind(normaliseContactNumber(contact_number), params.id).run();
    }
    if (email != null) {
      const invalid = validateEmail(email);
      if (invalid) return err(invalid);
      await env.DB.prepare('UPDATE clippers SET email = ? WHERE id = ?').bind(normaliseEmail(email), params.id).run();
    }
    if (legal_name != null) {
      await env.DB.prepare('UPDATE clippers SET legal_name = ? WHERE id = ?').bind(String(legal_name).trim(), params.id).run();
    }
    // Fallback contact channel (migration 035) -- same "admin can enter it
    // on their behalf" reasoning as everything else in this block. Unlike
    // the others, empty is a valid, non-error value (it's optional), so an
    // explicit clear is allowed through here too.
    if (discord_id != null) {
      const invalid = validateDiscordId(discord_id);
      if (invalid) return err(invalid);
      await env.DB.prepare('UPDATE clippers SET discord_id = ? WHERE id = ?')
        .bind(normaliseDiscordId(discord_id) || null, params.id).run();
    }
    return json({ ok: true });
  }

  // "Delete" archives, it never destroys: a clipper can carry paid-out
  // earnings history (submissions locked with a payment_id), and that must
  // never disappear. So this unlinks every social account exactly the way
  // the per-account Disconnect button does (disconnectSocialAccount --
  // pending clips removed, settled ones kept, only tokens/links stripped),
  // then marks the clipper 'deleted'. That single status flip is what moves
  // them out of the main roster into the admin's separate "Deleted" section
  // -- see the GET handler above and admin.html's loadDeletedClippers.
  if (params && method === 'DELETE') {
    const clipper = await env.DB.prepare('SELECT id, status FROM clippers WHERE id = ?').bind(params.id).first();
    if (!clipper) return err('Not found', 404);
    if (clipper.status === 'deleted') return json({ ok: true, already: true });

    const { results: accounts } = await env.DB.prepare(
      'SELECT id FROM social_accounts WHERE clipper_id = ?').bind(params.id).all();
    const touchedCampaigns = new Set();
    for (const a of accounts || []) {
      // preserveClips: archiving must not destroy unpaid work. See the
      // comment in disconnectSocialAccount -- this used to delete every
      // unlocked clip while the confirm dialog promised the opposite.
      const result = await disconnectSocialAccount(env.DB, a.id, { preserveClips: true });
      for (const cid of (result ? result.campaigns : [])) touchedCampaigns.add(cid);
    }
    for (const cid of touchedCampaigns) await reallocateCampaign(env.DB, cid);

    await env.DB.prepare(
      "UPDATE clippers SET status = 'deleted' WHERE id = ?").bind(params.id).run();
    return json({ ok: true });
  }

  // ------------------------------------------------------------- campaigns
  if (pathname === '/api/admin/campaigns' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all();
    const out = [];
    for (const c of results || []) {
      const parts = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM participations WHERE campaign_id = ? AND status != 'kicked'").bind(c.id).first();
      // "Joined" (parts.n, above) is one click and proves nothing about
      // whether someone is actually clipping for this campaign -- "active"
      // is a real post on it, recently, per ACTIVE_WINDOW_MS (db.js).
      const active = await env.DB.prepare(
        `SELECT COUNT(DISTINCT s.clipper_id) AS n
           FROM submissions s
           JOIN participations p ON p.clipper_id = s.clipper_id AND p.campaign_id = s.campaign_id
          WHERE s.campaign_id = ? AND s.status = 'active' AND p.status != 'kicked'
            AND COALESCE(s.posted_at, s.created_at) >= ?`
      ).bind(c.id, Date.now() - ACTIVE_WINDOW_MS).first();
      out.push({ ...(await campaignWithSpend(env.DB, c)), participants: parts.n, active_participants: active.n });
    }
    return json({ campaigns: out });
  }

  if (pathname === '/api/admin/campaigns' && method === 'POST') {
    const payload = await readJson(request);
    const name = (payload.name || '').trim();
    if (!name) return err('Campaign name is required');
    const cpm = Number(payload.cpm) || 0;
    const budget = Number(payload.budget) || 0;
    if (cpm <= 0) return err('CPM must be greater than 0');
    if (budget <= 0) return err('Budget must be greater than 0');
    // Views a clip must reach before it earns anything. Defaults to 1,000.
    const minViews = numOr(payload.min_views, 1000);
    const platforms = normalisePlatforms(payload.allowed_platforms);
    // Whether this campaign charges the 20% agency fee. Defaults to charging
    // it (matches the column default) so anyone who doesn't touch the
    // toggle gets today's behavior unchanged. 'internal' is for ClipGrow's
    // own self-promo campaigns -- no client, no fee, clipper payouts are a
    // real cost. See finance.js's header comment for the full split.
    const campaignKind = payload.campaign_kind === 'internal' ? 'internal' : 'client';
    const res = await env.DB.prepare(
      `INSERT INTO campaigns (name, description, cpm, budget, min_views, status, model, blueprint_json, allowed_platforms, campaign_kind, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
    ).bind(name, payload.description || '', cpm, budget, minViews, payload.model || '',
           JSON.stringify(pickBlueprint(payload)), platforms, campaignKind, now()).run();
    const id = res.meta.last_row_id;
    // Slug needs the id (for uniqueness), which only exists after insert --
    // set it in a follow-up UPDATE. Never changes after this, even if the
    // campaign is renamed later, so a shared /campaigns/:slug link never breaks.
    const slug = slugify(name, id);
    await env.DB.prepare('UPDATE campaigns SET slug = ? WHERE id = ?').bind(slug, id).run();
    return json({ ok: true, id, slug }, 201);
  }

  // A client top-up, exactly like the Payments tab's client-payment form --
  // same 20%-fee split -- plus it raises this campaign's budget by the pool
  // share in the same atomic write (src/finance.js's topUpCampaignBudget).
  // If the campaign had auto-completed from running dry, the next
  // allocation pass reopens it automatically.
  params = matchPath('/api/admin/campaigns/:id/top-up', pathname);
  if (params && method === 'POST') {
    const body = await readJson(request);
    const r = await topUpCampaignBudget(env.DB, {
      campaignId: Number(params.id), amount: body.amount,
      feePercent: body.fee_percent != null ? Number(body.fee_percent) : 20,
      method: body.method, reference: body.reference, note: body.note,
      occurredAt: body.occurred_at || null, createdBy: 'admin'
    });
    if (r.error) return err(r.error, r.status || 400);
    await reallocateCampaign(env.DB, Number(params.id));
    return json(r, 201);
  }

  // "How much do I still owe on THIS campaign?" -- previously answerable only
  // one clipper at a time, by picking a campaign in the Payouts tab. Every
  // piece already existed: payableClips accepts a campaignId.
  params = matchPath('/api/admin/campaigns/:id/payable', pathname);
  if (params && method === 'GET') {
    const campaignId = Number(params.id);
    const campaign = await env.DB.prepare('SELECT id, name FROM campaigns WHERE id = ?').bind(campaignId).first();
    if (!campaign) return err('Not found', 404);

    const { results: parts } = await env.DB.prepare(
      `SELECT DISTINCT p.clipper_id, cl.username, cl.display_name
         FROM participations p JOIN clippers cl ON cl.id = p.clipper_id
        WHERE p.campaign_id = ?`
    ).bind(campaignId).all();

    const rows = [];
    for (const p of parts || []) {
      const { totals } = await payableClips(env.DB, p.clipper_id, { days: 0, campaignId });
      if (!totals.payable_clips && !totals.settled_clips) continue;
      rows.push({
        clipper_id: p.clipper_id, username: p.username, display_name: p.display_name,
        payable_now: totals.payable_now, payable_clips: totals.payable_clips,
        already_settled: totals.already_settled, settled_clips: totals.settled_clips,
        below_min_clips: totals.below_min_clips, meets_minimum: totals.meets_minimum
      });
    }
    rows.sort((a, b) => b.payable_now - a.payable_now);

    return json({
      campaign: { id: campaign.id, name: campaign.name },
      clippers: rows,
      totals: {
        // Gross pending on this campaign. Deliberately NOT advance-netted:
        // advances are a clipper-level concept with no campaign dimension, so
        // a per-campaign "owed" cannot honestly exist.
        payable_now: rows.reduce((n, r) => n + r.payable_now, 0),
        payable_clips: rows.reduce((n, r) => n + r.payable_clips, 0),
        already_settled: rows.reduce((n, r) => n + r.already_settled, 0),
        clippers: rows.length,
        below_minimum: rows.filter(r => r.payable_now > 0 && !r.meets_minimum).length
      }
    });
  }

  params = matchPath('/api/admin/campaigns/:id/participants', pathname);
  if (params && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.status, p.status_note, p.joined_at, p.clipper_id, p.inactive_at,
              cl.username, cl.display_name,
              a.username AS account_username, a.status AS account_status, a.account_type, a.last_error_code,
              (SELECT GROUP_CONCAT(a2.platform || ':' || COALESCE(a2.username,'') || ':' || a2.status, '|')
                 FROM participation_accounts pa JOIN social_accounts a2 ON a2.id = pa.account_id
                 WHERE pa.participation_id = p.id) AS linked_accounts,
              (SELECT COUNT(*) FROM submissions s WHERE s.clipper_id=p.clipper_id AND s.campaign_id=p.campaign_id AND s.status='active') AS videos,
              (SELECT COALESCE(SUM(views),0) FROM submissions s WHERE s.clipper_id=p.clipper_id AND s.campaign_id=p.campaign_id AND s.status='active') AS views,
              (SELECT ${SPEND_EXPR} FROM submissions s WHERE s.clipper_id=p.clipper_id AND s.campaign_id=p.campaign_id) AS earned,
              (SELECT ${pendingClipperExpr('s')} FROM submissions s WHERE s.clipper_id=p.clipper_id AND s.campaign_id=p.campaign_id) AS pending,
              (SELECT COALESCE(SUM(CASE WHEN s.locked_at IS NOT NULL THEN COALESCE(s.locked_earning,0) ELSE 0 END),0)
                 FROM submissions s WHERE s.clipper_id=p.clipper_id AND s.campaign_id=p.campaign_id) AS settled
       FROM participations p
       JOIN clippers cl ON cl.id = p.clipper_id
       LEFT JOIN social_accounts a ON a.id = p.account_id
       WHERE p.campaign_id = ? ORDER BY earned DESC`
    ).bind(params.id).all();
    return json({ participants: results || [] });
  }

  params = matchPath('/api/admin/campaigns/:id', pathname);
  if (params && method === 'GET') {
    const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(params.id).first();
    if (!campaign) return err('Not found', 404);
    const { results: submissions } = await env.DB.prepare(
      // locked_at / lock_reason / payment_id were missing, so the UI could not
      // tell a settled clip from an open one and rendered Pause, Disqualify and
      // Delete on every row -- all three of which the API rejects with a 409
      // once a clip is paid. Every one of those buttons was guaranteed to fail
      // after the first payout run, which is the error the founder walked into.
      `SELECT s.id, s.permalink, s.views, s.earning, s.status, s.sync_error, s.sync_error_acknowledged_as, s.created_at, s.last_synced_at, s.source, s.platform,
              s.locked_at, s.locked_earning, s.lock_reason, s.payment_id,
              cl.username, a.username AS account_username
       FROM submissions s JOIN clippers cl ON cl.id = s.clipper_id
       LEFT JOIN social_accounts a ON a.id = s.account_id
       WHERE s.campaign_id = ? ORDER BY s.created_at ASC`
    ).bind(params.id).all();
    return json({
      // campaign_kind/fee_percent are admin-only -- spread on top rather
      // than added to publicCampaign, which this same helper feeds to the
      // homepage, SEO pages, and the client/clipper dashboards.
      campaign: { ...(await campaignWithSpend(env.DB, campaign)), campaign_kind: campaign.campaign_kind, fee_percent: campaign.fee_percent },
      submissions: submissions || []
    });
  }

  if (params && method === 'PATCH') {
    const payload = await readJson(request);
    const existing = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(params.id).first();
    if (!existing) return err('Not found', 404);
    if (payload.status && !CAMPAIGN_STATUSES.includes(payload.status)) {
      return err(`'${payload.status}' is not a valid campaign status. Accepted: ${CAMPAIGN_STATUSES.join(', ')}.`);
    }
    const priorBlueprint = JSON.parse(existing.blueprint_json || '{}');
    const merged = { ...priorBlueprint, ...pickBlueprint(payload) };
    // The per-video cap lives in the blueprint, not in a column, so a change to
    // it used to slip past the repricing check below -- the campaign kept
    // paying the old cap until some unrelated refresh happened to run.
    const capChanged = String(priorBlueprint.max_payout ?? '') !== String(merged.max_payout ?? '');
    // Any status change made through THIS endpoint is inherently a human
    // decision -- 'manual', never 'budget_exhausted' (that reason is only
    // ever written by the automatic budget-math transition in
    // src/earnings.js's allocateCampaignEarnings). Marking Over here must
    // never later look like something a budget top-up should silently
    // reopen. Reopening via this same endpoint (status set to anything but
    // 'completed') clears a stale reason; leaving status untouched in a
    // regular edit leaves completed_reason untouched too.
    const completedReason = payload.status
      ? (payload.status === 'completed' ? 'manual' : null)
      : existing.completed_reason;
    await env.DB.prepare(
      `UPDATE campaigns SET name = ?, description = ?, cpm = ?, budget = ?, min_views = ?, status = ?, completed_reason = ?, model = ?, blueprint_json = ?, allowed_platforms = ?, campaign_kind = ? WHERE id = ?`
    ).bind(
      payload.name != null ? String(payload.name).trim() || existing.name : existing.name,
      payload.description != null ? payload.description : existing.description,
      // `Number(x) || existing` treated a deliberate 0 as "unset": an admin
      // zeroing the budget to freeze a campaign got a success toast and no
      // change, while a negative number was accepted. Take any finite value
      // from 0 up, and fall back only when the input is not a usable number.
      numOr(payload.cpm, existing.cpm),
      numOr(payload.budget, existing.budget),
      numOr(payload.min_views, existing.min_views),
      payload.status || existing.status,
      completedReason,
      payload.model != null ? payload.model : existing.model,
      JSON.stringify(merged),
      payload.allowed_platforms != null
        ? normalisePlatforms(payload.allowed_platforms)
        : (existing.allowed_platforms || 'instagram'),
      payload.campaign_kind != null
        ? (payload.campaign_kind === 'internal' ? 'internal' : 'client')
        : existing.campaign_kind,
      params.id
    ).run();
    // CPM, budget or threshold changes re-price every submission in this campaign.
    if (payload.cpm != null || payload.budget != null || payload.min_views != null || capChanged) {
      await reallocateCampaign(env.DB, params.id);
    }
    return json({ ok: true });
  }

  // Dismisses the clipper-facing "campaign ended" recap card, for
  // everyone at once -- one founder action, not per-clipper. Only makes
  // sense once the campaign has actually completed.
  params = matchPath('/api/admin/campaigns/:id/hide-recap', pathname);
  if (params && method === 'POST') {
    const existingCampaign = await env.DB.prepare('SELECT status FROM campaigns WHERE id = ?').bind(params.id).first();
    if (!existingCampaign) return err('Not found', 404);
    if (existingCampaign.status !== 'completed') return err('This campaign has not ended yet.');
    await env.DB.prepare('UPDATE campaigns SET recap_hidden_at = ? WHERE id = ?').bind(now(), params.id).run();
    return json({ ok: true });
  }

  // Re-matched: the hide-recap block above reassigned `params` to its own
  // (narrower) pattern, which would otherwise silently break the DELETE
  // handler below for every normal /api/admin/campaigns/:id request.
  params = matchPath('/api/admin/campaigns/:id', pathname);
  if (params && method === 'DELETE') {
    const subCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions WHERE campaign_id = ?').bind(params.id).first();
    if (subCount.n > 0) {
      return err(`This campaign has ${subCount.n} submission(s). Mark it as over instead of deleting, so clipper earnings are preserved.`, 409);
    }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM participations WHERE campaign_id = ?').bind(params.id),
      env.DB.prepare('DELETE FROM campaigns WHERE id = ?').bind(params.id)
    ]);
    return json({ ok: true });
  }

  // --------------------------------------------------------- participations
  params = matchPath('/api/admin/participations/:id', pathname);
  if (params && method === 'PATCH') {
    const { status, note, account_id, clear_inactive } = await readJson(request);
    const part = await env.DB.prepare('SELECT * FROM participations WHERE id = ?').bind(params.id).first();
    if (!part) return err('Not found', 404);
    if (status && !PART_STATUSES.includes(status)) {
      return err(`'${status}' is not a valid participation status. Accepted: ${PART_STATUSES.join(', ')}.`);
    }
    await env.DB.prepare(
      'UPDATE participations SET status = ?, status_note = ?, account_id = ?, inactive_at = ? WHERE id = ?'
    ).bind(
      status || part.status,
      note != null ? note : part.status_note,
      account_id !== undefined ? account_id : part.account_id,
      // Manual early reinstatement -- the automatic path is connecting an
      // account (linkParticipationAccount clears this on its own); this is
      // for the admin to say "I know they're back" without waiting on that.
      clear_inactive ? null : part.inactive_at,
      params.id
    ).run();
    // Kicking freezes this clipper's unpaid clips at what they are worth right
    // now, so later repricing cannot erode them. Reinstating clears the freeze
    // and hands them back to normal pricing. Settled clips are untouched --
    // their money is already locked.
    if (status && status !== part.status) {
      if (status === 'kicked') {
        await env.DB.prepare(
          `UPDATE submissions SET frozen_earning = earning
            WHERE clipper_id = ? AND campaign_id = ? AND locked_at IS NULL AND frozen_earning IS NULL`
        ).bind(part.clipper_id, part.campaign_id).run();
      } else if (part.status === 'kicked') {
        await env.DB.prepare(
          `UPDATE submissions SET frozen_earning = NULL
            WHERE clipper_id = ? AND campaign_id = ? AND locked_at IS NULL`
        ).bind(part.clipper_id, part.campaign_id).run();
      }
      await reallocateCampaign(env.DB, part.campaign_id);

      // Audit log: only kick and pause, per the founder's explicit list --
      // reinstating to 'active' is deliberately left un-logged.
      if (status === 'kicked' || status === 'paused') {
        const who = await env.DB.prepare(
          'SELECT cl.username AS clipper_username, c.name AS campaign_name FROM clippers cl, campaigns c WHERE cl.id = ? AND c.id = ?'
        ).bind(part.clipper_id, part.campaign_id).first();
        await logAction(env.DB, {
          staffType: 'admin', staffName: 'Admin',
          action: status === 'kicked' ? 'clipper_kicked' : 'participation_paused',
          targetType: 'participation', targetId: Number(params.id),
          targetLabel: who ? `${who.clipper_username} — ${who.campaign_name}` : null
        });
      }
    }
    return json({ ok: true });
  }

  if (params && method === 'DELETE') {
    const part = await env.DB.prepare('SELECT * FROM participations WHERE id = ?').bind(params.id).first();
    if (!part) return err('Not found', 404);
    const subs = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM submissions WHERE clipper_id = ? AND campaign_id = ?')
      .bind(part.clipper_id, part.campaign_id).first();
    if (subs.n > 0) return err(`This clipper has ${subs.n} video(s) in this campaign. Use Kick instead so their earnings are preserved.`, 409);
    await env.DB.prepare('DELETE FROM participations WHERE id = ?').bind(params.id).run();
    return json({ ok: true });
  }

  // -------------------------------------------------------- tester requests
  // Manual queue ahead of OAuth: the Meta app is in Development Mode, so an
  // Instagram account must be an accepted app Tester before a clipper's
  // Connect Instagram can ever succeed. The admin adds/confirms the tester by
  // hand in the Meta dashboard; these endpoints just track that state.
  const TESTER_STATUSES = ['requested', 'invited', 'confirmed', 'rejected'];

  if (pathname === '/api/admin/access-requests' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT t.*, COALESCE(t.identifier, t.ig_username) AS identifier,
              cl.username AS clipper_username, cl.display_name AS clipper_display_name,
              c.name AS campaign_name,
              -- Whether this exact account was already approved on another
              -- campaign. Tester/test-user status is app-level on both
              -- platforms, so if it was, there is nothing to do in Meta or
              -- Google Cloud and this can simply be approved.
              (SELECT COUNT(*) FROM tester_requests p
                WHERE p.clipper_id = t.clipper_id
                  AND p.platform = t.platform
                  AND COALESCE(p.identifier, p.ig_username) = COALESCE(t.identifier, t.ig_username)
                  AND p.status = 'confirmed' AND p.id != t.id) AS already_granted,
              -- Whether they have since connected, so a stale queue entry is
              -- visibly resolved rather than looking like outstanding work.
              (SELECT COUNT(*) FROM participation_accounts pa
                JOIN participations pp ON pp.id = pa.participation_id
                JOIN social_accounts sa ON sa.id = pa.account_id
                WHERE pp.clipper_id = t.clipper_id AND pp.campaign_id = t.campaign_id
                  AND pa.platform = t.platform AND sa.status != 'revoked') AS is_connected
       FROM tester_requests t
       JOIN clippers cl ON cl.id = t.clipper_id
       LEFT JOIN campaigns c ON c.id = t.campaign_id
       ORDER BY
         CASE t.status WHEN 'requested' THEN 0 WHEN 'invited' THEN 1 ELSE 2 END,
         t.requested_at DESC`
    ).all();
    return json({ requests: results || [] });
  }

  params = matchPath('/api/admin/access-requests/:id', pathname);
  if (params && method === 'PATCH') {
    const { status, note, auto_import } = await readJson(request);
    const reqRow = await env.DB.prepare(
      `SELECT t.*, cl.username AS clipper_username FROM tester_requests t
       JOIN clippers cl ON cl.id = t.clipper_id WHERE t.id = ?`
    ).bind(params.id).first();
    if (!reqRow) return err('Not found', 404);
    if (status && !TESTER_STATUSES.includes(status)) {
      return err(`'${status}' is not a valid access-request status. Accepted: ${TESTER_STATUSES.join(', ')}.`);
    }

    const nextStatus = status || reqRow.status;
    const nextAutoImport = auto_import != null ? (auto_import ? 1 : 0) : reqRow.auto_import;
    await env.DB.prepare(
      'UPDATE tester_requests SET status = ?, note = ?, auto_import = ? WHERE id = ?'
    ).bind(
      nextStatus, note != null ? note : reqRow.note, nextAutoImport,
      params.id
    ).run();
    // The pre-plan toggle (migration 016 -- carries the choice into the
    // account created once the clipper connects) and the per-account
    // toggle in the Connected Accounts table are the same lever, not two
    // that can disagree depending on when you happen to flip it: if this
    // clipper already connected for this campaign/platform, apply the new
    // value to that real account right now too, instead of only affecting
    // a future reconnect.
    if (auto_import != null) {
      await env.DB.prepare(
        `UPDATE social_accounts SET auto_import = ?
         WHERE id IN (
           SELECT pa.account_id FROM participation_accounts pa
           JOIN participations p ON p.id = pa.participation_id
           WHERE p.clipper_id = ? AND p.campaign_id = ? AND pa.platform = ?
         )`
      ).bind(nextAutoImport, reqRow.clipper_id, reqRow.campaign_id, reqRow.platform).run();
    }
    // Audit log: only an actual approval transition, not a re-save of an
    // already-confirmed row, and not a rejection -- left room for the day
    // approvals are ever delegated to a moderator, even though that's not
    // wired into moderator.js yet.
    if (nextStatus === 'confirmed' && reqRow.status !== 'confirmed') {
      await logAction(env.DB, {
        staffType: 'admin', staffName: 'Admin', action: 'access_request_approved',
        targetType: 'tester_request', targetId: Number(params.id),
        targetLabel: `${reqRow.platform}:${reqRow.identifier || reqRow.ig_username} (${reqRow.clipper_username})`
      });
    }
    return json({ ok: true });
  }

  // Guide management via the admin panel was removed -- it was a full CMS
  // form for content with no clear ongoing use. The public pages this
  // content feeds (src/routes/guides.js, /guides/:slug) are untouched and
  // keep rendering from the guides table exactly as before. A guide can
  // still be edited directly in D1 if ever needed; there is deliberately
  // no admin UI for it until there's a real reason to rebuild one.

  // ------------------------------------------------------------ submissions
  params = matchPath('/api/admin/submissions/:id', pathname);
  if (params && (method === 'PATCH' || method === 'DELETE')) {
    const sub = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(params.id).first();
    if (!sub) return err('Not found', 404);
    // A clip attached to a real payment (payment_id set) is closed financial
    // history: money was actually sent against this exact amount. Editing or
    // deleting it would silently desync the payment ledger, so it is refused
    // outright -- reverse the payment first if it was a mistake.
    //
    // A clip locked at zero with NO payment attached (lock_reason='below_min',
    // written off through settlePayment or the write-off sweep) carries no
    // money at all -- there is nothing to desync, so it can be deleted outright
    // for exactly the case a locked-but-worthless test/trial clip needs. It
    // still can't be PATCHed (paused/disqualified) while locked, since those
    // are states for an open clip; unlock it first if it needs to change.
    if (sub.locked_at && sub.payment_id) {
      return err('This clip is locked because it has already been paid. Reverse that payment first if you need to change it.', 409);
    }
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM submissions WHERE id = ?').bind(params.id).run();
    } else {
      if (sub.locked_at) {
        return err('This clip is closed (settled at zero). Reopen it first if you need to change its status.', 409);
      }
      // 'paused' = temporarily not monetised (under review, off-guidelines).
      // 'disqualified' = permanently rejected. Both earn nothing and hand their
      // share of the budget back; only 'active' accrues.
      const { status } = await readJson(request);
      // Was a bare 'Invalid status' with no guard against an unparseable body,
      // so a malformed request and a genuinely wrong value produced the same
      // uninformative message -- one of the two strings behind the founder's
      // "invalid request" report.
      if (status == null) return err("This needs a 'status' field. Accepted: active, paused, disqualified.");
      if (!['active', 'paused', 'disqualified'].includes(status)) {
        return err(`'${status}' is not a valid video status. Accepted: active, paused, disqualified.`);
      }
      await env.DB.prepare('UPDATE submissions SET status = ? WHERE id = ?').bind(status, params.id).run();
    }
    await reallocateCampaign(env.DB, sub.campaign_id);
    return json({ ok: true });
  }

  // "I've looked at this video's sync issue, it's not worth chasing" --
  // mirrors /api/admin/accounts/:id/acknowledge (migration 022) but for one
  // submission's sync_error (migration 029). Deliberately reversible (unlike
  // 'disqualified', it touches nothing about earning/locking): acknowledging
  // stores the exact sync_error value, so it stays suppressed only while
  // nothing has actually changed and reopens on its own the moment a fresh,
  // different error occurs; un-acknowledging just clears it back out.
  // MEDIA_NOT_FOUND/PRE_CONVERSION_MEDIA never need this -- they already
  // read as calm, explained badges (TERMINAL_SYNC_ERRORS) with nothing to
  // acknowledge.
  params = matchPath('/api/admin/submissions/:id/acknowledge-sync-error', pathname);
  if (params && method === 'PATCH') {
    const { acknowledge } = await readJson(request);
    const sub = await env.DB.prepare('SELECT id, sync_error FROM submissions WHERE id = ?').bind(params.id).first();
    if (!sub) return err('Not found', 404);
    if (acknowledge === false) {
      await env.DB.prepare('UPDATE submissions SET sync_error_acknowledged_as = NULL WHERE id = ?').bind(params.id).run();
    } else {
      if (!sub.sync_error) return err('This video has no sync issue to skip.');
      await env.DB.prepare('UPDATE submissions SET sync_error_acknowledged_as = ? WHERE id = ?')
        .bind(sub.sync_error, params.id).run();
    }
    return json({ ok: true });
  }

  // --------------------------------------------------------------- accounts
  // Switches an account between automatic tracking and paste-only. Used when a
  // clipper posts campaign work from their MAIN account, where auto-import
  // would otherwise sweep in their unrelated personal videos.
  params = matchPath('/api/admin/accounts/:id', pathname);
  if (params && method === 'PATCH') {
    const body = await readJson(request);
    if (typeof body.auto_import !== 'boolean') return err('auto_import must be true or false');
    const account = await env.DB.prepare('SELECT id FROM social_accounts WHERE id = ?').bind(params.id).first();
    if (!account) return err('Account not found', 404);
    await env.DB.prepare('UPDATE social_accounts SET auto_import = ? WHERE id = ?')
      .bind(body.auto_import ? 1 : 0, params.id).run();
    return json({ ok: true, auto_import: body.auto_import });
  }

  // Fully disconnects an account so a different one can be connected in its
  // place: unlinks it from the participation, deletes its pending clips, and
  // keeps whatever was already settled. See disconnectSocialAccount.
  //
  // resetAccess:true additionally reopens the tester_requests row for every
  // campaign this account was driving, so the clipper's dashboard shows Step 1
  // (enter a new handle) instead of skipping straight to Connect with a stale
  // approval. Before this existed, doing that meant hand-writing SQL for each
  // case -- this collapses it into the one action the disconnect dialog was
  // already implying was possible.
  if (params && method === 'DELETE') {
    const before = await env.DB.prepare(
      `SELECT sa.clipper_id, cl.username AS clipper_username FROM social_accounts sa
       JOIN clippers cl ON cl.id = sa.clipper_id WHERE sa.id = ?`
    ).bind(params.id).first();
    if (!before) return err('Account not found', 404);
    const { resetAccess } = await readJson(request).catch(() => ({}));

    // Campaigns this account is actually linked to, from participation_accounts
    // -- not from disconnectSocialAccount's returned `campaigns`, which is
    // derived purely from submissions.campaign_id and comes back EMPTY for an
    // account that never posted a clip yet. That's a real, common case (a
    // freshly-connected clipper who hasn't submitted anything), and resetAccess
    // silently doing nothing for it would be exactly the kind of stuck state
    // this feature exists to eliminate. Read before disconnecting -- it deletes
    // these rows.
    const { results: linkedParts } = resetAccess
      ? await env.DB.prepare(
          `SELECT DISTINCT p.campaign_id FROM participation_accounts pa
             JOIN participations p ON p.id = pa.participation_id
             WHERE pa.account_id = ?`
        ).bind(params.id).all()
      : { results: [] };

    const result = await disconnectSocialAccount(env.DB, Number(params.id));
    // Those pending clips were holding budget; it has to be re-spread across
    // whatever is still open in each affected campaign.
    for (const cid of result.campaigns) await reallocateCampaign(env.DB, cid);

    let reset_requests = 0;
    const campaignIds = [...new Set([...(linkedParts || []).map(r => r.campaign_id), ...result.campaigns])];
    if (resetAccess && campaignIds.length) {
      const ph = campaignIds.map(() => '?').join(',');
      const res = await env.DB.prepare(
        `UPDATE tester_requests SET status = 'rejected',
           note = 'Account disconnected -- resubmit a new handle.'
         WHERE clipper_id = ? AND platform = ? AND campaign_id IN (${ph})`
      ).bind(before.clipper_id, result.platform, ...campaignIds).run();
      reset_requests = res.meta.changes || 0;
    }
    await logAction(env.DB, {
      staffType: 'admin', staffName: 'Admin', action: 'account_removed',
      targetType: 'social_account', targetId: Number(params.id),
      targetLabel: `${result.platform}:${result.username} (${before.clipper_username})`
    });
    return json({ ok: true, ...result, reset_requests });
  }

  // All social accounts across every clipper, bucketed into Active / Paused /
  // Removed / Issues. Precedence matters -- checked in this order so a real
  // open problem is never hidden behind a "tracking paused" label:
  //   revoked (admin-disconnected)  ->  open issue  ->  tracking paused  ->  active
  //
  // Neither acknowledgment is a plain "dismissed forever" flag -- each stores
  // what was true AT THE MOMENT of acknowledgment (see migration 022), so a
  // bucket only stays suppressed while nothing has actually changed since.
  if (pathname === '/api/admin/accounts' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT a.*, cl.display_name AS clipper_display_name, cl.username AS clipper_username,
         (SELECT COALESCE(tr.identifier, tr.ig_username) FROM tester_requests tr
            JOIN participation_accounts pa ON pa.account_id = a.id
            JOIN participations p ON p.id = pa.participation_id AND p.campaign_id = tr.campaign_id
            WHERE tr.clipper_id = a.clipper_id AND tr.platform = a.platform AND tr.status = 'confirmed'
              AND COALESCE(tr.identifier, tr.ig_username) != a.username
            LIMIT 1) AS mismatch_approved_as
       FROM social_accounts a JOIN clippers cl ON cl.id = a.clipper_id
       WHERE cl.status != 'deleted'
       ORDER BY cl.username, a.platform`
    ).all();

    const buckets = { active: [], paused: [], removed: [], issues: [] };
    for (const a of results || []) {
      const { mismatchOpen, errorOpen } = accountIssues(a);
      const reasons = [];
      if (mismatchOpen) reasons.push('mismatch');
      if (errorOpen) reasons.push(a.status === 'needs_reauth' ? 'needs_reauth' : 'import_failing');

      const row = {
        id: a.id,
        clipper_id: a.clipper_id,
        clipper_name: a.clipper_display_name || a.clipper_username,
        platform: a.platform,
        username: a.username,
        status: a.status,
        auto_import: a.auto_import !== 0,
        last_error_code: a.last_error_code,
        last_error_at: a.last_error_at,
        mismatch_approved_as: mismatchOpen ? a.mismatch_approved_as : null,
        reasons
      };

      if (a.status === 'revoked') buckets.removed.push(row);
      else if (reasons.length) buckets.issues.push(row);
      else if (!row.auto_import) buckets.paused.push(row);
      else buckets.active.push(row);
    }
    return json(buckets);
  }

  // Tells the dashboard "I've looked at this, it's not a problem" for one
  // account's flagged issue. Deliberately not a confirm-gated destructive
  // action -- see migration 022's comment for why this is safe to reverse
  // itself automatically rather than needing an "undo".
  params = matchPath('/api/admin/accounts/:id/acknowledge', pathname);
  if (params && method === 'PATCH') {
    const { type } = await readJson(request);
    if (type !== 'mismatch' && type !== 'error') return err("type must be 'mismatch' or 'error'");
    const account = await env.DB.prepare('SELECT id FROM social_accounts WHERE id = ?').bind(params.id).first();
    if (!account) return err('Account not found', 404);
    if (type === 'mismatch') {
      await env.DB.prepare('UPDATE social_accounts SET mismatch_acknowledged_as = username WHERE id = ?')
        .bind(params.id).run();
    } else {
      await env.DB.prepare('UPDATE social_accounts SET error_acknowledged_at = ? WHERE id = ?')
        .bind(now(), params.id).run();
    }
    return json({ ok: true });
  }

  // ---------------------------------------------------------------- payouts
  // Everything a payout run needs: each clip in the window with its posted and
  // synced dates, whether it cleared the campaign minimum, whether the
  // per-video cap bit, and what is already settled.
  params = matchPath('/api/admin/clippers/:id/payable', pathname);
  if (params && method === 'GET') {
    const clipper = await env.DB.prepare('SELECT id FROM clippers WHERE id = ?').bind(params.id).first();
    if (!clipper) return err('Clipper not found', 404);
    const daysRaw = url.searchParams.get('days');
    const days = daysRaw === 'all' ? 0 : Math.max(0, Number(daysRaw) || 30);
    const campaignId = url.searchParams.get('campaign_id') || null;
    const data = await payableClips(env.DB, Number(params.id), {
      days,
      campaignId: campaignId ? Number(campaignId) : null
    });
    return json({ ...data, days });
  }

  // One-click sweep: closes below-minimum, unlocked clips at zero, scoped to
  // a campaign/clipper if given or across everyone if not. Only touches a
  // clip whose clipper already had a payout run that should have covered it
  // (see writeOffAllBelowMin) -- a clip still waiting on its first-ever
  // payout is left alone, since it may still clear the minimum before then.
  // Money-neutral either way (these clips already earn 0).
  if (pathname === '/api/admin/payouts/write-off-below-min' && method === 'POST') {
    const body = await readJson(request).catch(() => ({}));
    const result = await writeOffAllBelowMin(env.DB, {
      campaignId: body.campaign_id ? Number(body.campaign_id) : null,
      clipperId: body.clipper_id ? Number(body.clipper_id) : null
    });
    return json(result);
  }

  // Records the payment AND locks every clip it covers, in one call. Locking is
  // what stops a clip being paid for twice and what stops its amount being
  // rewritten later.
  if (pathname === '/api/admin/payouts/settle' && method === 'POST') {
    const body = await readJson(request);
    if (!body.clipper_id) return err('Pick a clipper');
    const result = await settlePayment(env.DB, {
      clipperId: Number(body.clipper_id),
      submissionIds: Array.isArray(body.submission_ids) ? body.submission_ids : [],
      writeOffIds: Array.isArray(body.write_off_ids) ? body.write_off_ids : [],
      amount: body.amount,
      // What the admin's page displayed as the clip total. Optional so an older
      // cached page still settles; when present it is enforced.
      expectedClipsTotal: body.expected_clips_total != null ? body.expected_clips_total : null,
      campaignId: body.campaign_id ? Number(body.campaign_id) : null,
      method: body.method,
      reference: body.reference,
      note: body.note,
      paidAt: body.paid_at,
      // Deliberate, per-run override of the Rs 500 floor.
      allowBelowMinimum: !!body.allow_below_minimum,
      walletId: body.wallet_id ? Number(body.wallet_id) : null,
      // The agency does not fund campaigns out of anyone's pocket, so a
      // payout it cannot cover is refused unless deliberately overridden.
      allowUnfunded: !!body.allow_unfunded
    });
    if (result.error) {
      return json({ error: result.error, locked_ids: result.locked_ids,
                    below_minimum: result.below_minimum, payout_minimum: result.payout_minimum },
                  result.status || 400);
    }
    return json({ ...result, money: await clipperFinancials(env.DB, body.clipper_id) }, 201);
  }

  // Reopens a clip that was closed at zero for missing the campaign minimum.
  // Deliberately refuses clips locked by a payment: those must go back through
  // the payment reversal, so the ledger and the locks can never drift apart.
  params = matchPath('/api/admin/submissions/:id/unlock', pathname);
  if (params && method === 'POST') {
    const sub = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(params.id).first();
    if (!sub) return err('Not found', 404);
    if (!sub.locked_at) return err('This clip is not locked', 400);
    if (sub.lock_reason === 'paid') {
      return err('This clip was locked by a payment. Reverse that payment instead, so the ledger stays correct.', 409);
    }
    await env.DB.prepare(
      'UPDATE submissions SET locked_at = NULL, locked_earning = NULL, lock_reason = NULL WHERE id = ?'
    ).bind(params.id).run();
    await reallocateCampaign(env.DB, sub.campaign_id);
    return json({ ok: true });
  }

  // --------------------------------------------------------------- payments
  if (pathname === '/api/admin/payments' && method === 'GET') {
    const clipperId = url.searchParams.get('clipper_id');
    const sql = clipperId
      ? `SELECT p.*, cl.username, c.name AS campaign_name FROM payments p
         JOIN clippers cl ON cl.id = p.clipper_id LEFT JOIN campaigns c ON c.id = p.campaign_id
         WHERE p.clipper_id = ? ORDER BY p.paid_at DESC`
      : `SELECT p.*, cl.username, c.name AS campaign_name FROM payments p
         JOIN clippers cl ON cl.id = p.clipper_id LEFT JOIN campaigns c ON c.id = p.campaign_id
         ORDER BY p.paid_at DESC LIMIT 200`;
    const stmt = clipperId ? env.DB.prepare(sql).bind(clipperId) : env.DB.prepare(sql);
    const { results } = await stmt.all();
    return json({ payments: results || [] });
  }

  if (pathname === '/api/admin/payments' && method === 'POST') {
    const { clipper_id, campaign_id, amount, method: payMethod, reference, note, paid_at, kind } = await readJson(request);
    if (!clipper_id) return err('Pick a clipper');
    // This endpoint records money that was sent WITHOUT settling any videos --
    // the clips stay open and payable. That is only ever correct for money that
    // is not payment for specific videos, so it has to say which it is:
    //   advance - paid up front, owed back out of the next settlement
    //   bonus   - extra money, never deducted from what the clipper is owed
    // Settling videos goes through the payouts flow, which locks them.
    const payKind = kind === 'bonus' ? 'bonus' : kind === 'advance' ? 'advance' : null;
    if (!payKind) return err('Say whether this is an advance or a bonus. To pay for specific videos, use the Payouts tab so they get locked.');
    const amt = Math.round(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) return err('Amount must be greater than 0');
    const clipper = await env.DB.prepare('SELECT id FROM clippers WHERE id = ?').bind(clipper_id).first();
    if (!clipper) return err('Clipper not found', 404);
    if (campaign_id && !(await getCampaignById(env.DB, campaign_id))) return err('Campaign not found', 404);
    const res = await env.DB.prepare(
      `INSERT INTO payments (clipper_id, campaign_id, amount, method, reference, note, paid_at, created_at, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(clipper_id, campaign_id || null, amt, payMethod || 'UPI', reference || '', note || '',
           paid_at ? Number(paid_at) : now(), now(), payKind).run();
    return json({ ok: true, id: res.meta.last_row_id, money: await clipperFinancials(env.DB, clipper_id) }, 201);
  }

  params = matchPath('/api/admin/payments/:id', pathname);
  if (params && method === 'DELETE') {
    // Routed through the reversal so the clips this payment locked are released
    // too. Deleting the row on its own would strand them locked forever with a
    // dangling payment_id.
    const result = await reversePayment(env.DB, Number(params.id));
    if (result.error) return json({ error: result.error }, result.status || 400);
    return json(result);
  }
  if (params && method === 'PATCH') {
    const { amount, method: payMethod, reference, note, paid_at } = await readJson(request);
    const pay = await env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(params.id).first();
    if (!pay) return err('Not found', 404);
    const amt = amount != null ? Math.round(Number(amount)) : pay.amount;
    if (!Number.isFinite(amt) || amt <= 0) return err('Amount must be greater than 0');
    await env.DB.prepare(
      'UPDATE payments SET amount = ?, method = ?, reference = ?, note = ?, paid_at = ? WHERE id = ?'
    ).bind(amt, payMethod != null ? payMethod : pay.method, reference != null ? reference : pay.reference,
           note != null ? note : pay.note, paid_at != null ? Number(paid_at) : pay.paid_at, params.id).run();
    return json({ ok: true });
  }

  // ---------------------------------------------------------------- clients
  // Read-only observer logins for brands, scoped to the campaigns granted here.
  if (pathname === '/api/admin/clients' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM clients ORDER BY created_at DESC').all();
    const out = [];
    for (const c of results || []) {
      const { results: camps } = await env.DB.prepare(
        `SELECT c.id, c.name FROM client_campaigns cc JOIN campaigns c ON c.id = cc.campaign_id
         WHERE cc.client_id = ? ORDER BY c.created_at DESC`
      ).bind(c.id).all();
      out.push({
        id: c.id, username: c.username, company_name: c.company_name,
        contact_name: c.contact_name, status: c.status, created_at: c.created_at,
        campaigns: camps || []
      });
    }
    return json({ clients: out });
  }

  if (pathname === '/api/admin/clients' && method === 'POST') {
    const { username, password, company_name, contact_name, campaign_ids } = await readJson(request);
    if (!username || !password) return err('Username and password are required');
    if (String(password).length < 6) return err('Password must be at least 6 characters');
    const clean = normalizeUsername(username);
    if (!clean) return err('Username cannot be blank');
    const existing = await env.DB.prepare('SELECT id FROM clients WHERE username = ? COLLATE NOCASE').bind(clean).first();
    if (existing) return err('That client username is already taken', 409);
    const { hash, salt } = await hashPassword(password);
    const res = await env.DB.prepare(
      `INSERT INTO clients (username, password_hash, password_salt, company_name, contact_name, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`
    ).bind(clean, hash, salt, company_name || clean, contact_name || '', now()).run();
    const clientId = res.meta.last_row_id;
    for (const cid of Array.isArray(campaign_ids) ? campaign_ids : []) {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO client_campaigns (client_id, campaign_id, granted_at) VALUES (?, ?, ?)'
      ).bind(clientId, Number(cid), now()).run();
    }
    return json({ ok: true, id: clientId, username: clean }, 201);
  }

  params = matchPath('/api/admin/clients/:id', pathname);
  if (params && method === 'PATCH') {
    const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(params.id).first();
    if (!client) return err('Not found', 404);
    const { status, company_name, contact_name, password, campaign_ids } = await readJson(request);
    if (status && !['active', 'disabled'].includes(status)) return err('Invalid status');
    await env.DB.prepare(
      'UPDATE clients SET status = ?, company_name = ?, contact_name = ? WHERE id = ?'
    ).bind(status || client.status,
           company_name != null ? company_name : client.company_name,
           contact_name != null ? contact_name : client.contact_name, params.id).run();
    if (password) {
      if (String(password).length < 6) return err('Password must be at least 6 characters');
      const { hash, salt } = await hashPassword(password);
      await env.DB.prepare('UPDATE clients SET password_hash = ?, password_salt = ? WHERE id = ?')
        .bind(hash, salt, params.id).run();
    }
    // Campaign grants are replaced wholesale when supplied, so unticking a
    // campaign in the admin UI actually revokes that client's access to it.
    if (Array.isArray(campaign_ids)) {
      await env.DB.prepare('DELETE FROM client_campaigns WHERE client_id = ?').bind(params.id).run();
      for (const cid of campaign_ids) {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO client_campaigns (client_id, campaign_id, granted_at) VALUES (?, ?, ?)'
        ).bind(params.id, Number(cid), now()).run();
      }
    }
    return json({ ok: true });
  }

  if (params && method === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM client_campaigns WHERE client_id = ?').bind(params.id),
      env.DB.prepare('DELETE FROM clients WHERE id = ?').bind(params.id)
    ]);
    return json({ ok: true });
  }

  // ----------------------------------------------------------------- export
  // Offline backup of the books. Generated live from D1 on every request, so a
  // download is always a true snapshot of the current state -- the point being
  // that it still tells you what was paid for even if the site is down.
  if (pathname === '/api/admin/export.csv' && method === 'GET') {
    const kind = url.searchParams.get('type') === 'payments' ? 'payments' : 'clips';
    const csv = kind === 'payments'
      ? await exportPaymentsCsv(env.DB)
      : await exportClipsCsv(env.DB);
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="clipgrow-${kind}-${stamp}.csv"`,
        'Cache-Control': 'no-store'
      }
    });
  }

  // ------------------------------------------------------------------- sync
  //
  // Tier 1: every account in every campaign for every clipper, as a chained
  // job. A single flat pass could not fit inside one invocation's external
  // subrequest budget -- the accounts last in the loop were being silently
  // truncated, which is what sync_error = 'SUBREQUEST_LIMIT' recorded.
  if (pathname === '/api/admin/refresh/global' && method === 'POST') {
    const created = await createRefreshJob(env.DB, {
      kind: 'global', triggeredBy: 'admin', respectCooldown: false
    });
    if (created.error) return json({ error: created.error, job_id: created.job_id }, created.status || 409);

    const first = await advanceJob(env.DB, env, created.job_id, { onFinish: () => reallocateAll(env.DB) });
    await logAction(env.DB, {
      staffType: 'admin', staffName: 'Admin', action: 'refresh_triggered',
      targetType: 'global', targetLabel: 'All clippers'
    });
    return json({
      ok: true, job_id: created.job_id,
      job: publicJob(await getJob(env.DB, created.job_id)),
      first_chunk: { calls: first.calls, done: first.done }
    });
  }

  // Tier 2 triggered by the admin instead of the clipper. Deliberately the
  // SAME job kind and the same lock, so admin and clipper cannot both start
  // one for the same person at the same time.
  params = matchPath('/api/admin/refresh/clipper/:id', pathname);
  if (params && method === 'POST') {
    const clipper = await env.DB.prepare('SELECT id, username FROM clippers WHERE id = ?').bind(params.id).first();
    if (!clipper) return err('Clipper not found', 404);

    const created = await createRefreshJob(env.DB, {
      kind: 'clipper', clipperId: Number(params.id), triggeredBy: 'admin', respectCooldown: false
    });
    if (created.error) return json({ error: created.error, job_id: created.job_id }, created.status || 409);

    const first = await advanceJob(env.DB, env, created.job_id, { onFinish: () => reallocateAll(env.DB) });
    await logAction(env.DB, {
      staffType: 'admin', staffName: 'Admin', action: 'refresh_triggered',
      targetType: 'clipper', targetId: Number(params.id), targetLabel: clipper.username
    });
    return json({
      ok: true, job_id: created.job_id,
      job: publicJob(await getJob(env.DB, created.job_id)),
      first_chunk: { calls: first.calls, done: first.done }
    });
  }

  // Listed BEFORE /:jobId so the literal path is not swallowed by the param.
  if (pathname === '/api/admin/refresh/jobs' && method === 'GET') {
    // There was no way to find a running job without already knowing its id:
    // if you had not clicked the button yourself, the run was invisible.
    return json({ jobs: await listJobs(env.DB, { limit: 20 }) });
  }

  params = matchPath('/api/admin/refresh/:jobId', pathname);
  if (params && method === 'GET') {
    const job = await getJob(env.DB, Number(params.jobId));
    if (!job) return err('Not found', 404);
    // The panel's whole point: which clip of which clipper failed, and why.
    return json({
      job: publicJob(job),
      failures: await jobFailureSummary(env.DB, Number(params.jobId)),
      events: await jobEvents(env.DB, Number(params.jobId), { limit: 200 })
    });
  }

  params = matchPath('/api/admin/refresh/:jobId/cancel', pathname);
  if (params && method === 'POST') {
    const r = await cancelJob(env.DB, Number(params.jobId));
    if (r.error) return err(r.error, r.status || 400);
    return json({ ok: true, job: publicJob(await getJob(env.DB, Number(params.jobId))) });
  }

  params = matchPath('/api/admin/refresh/:jobId/retry', pathname);
  if (params && method === 'POST') {
    const r = await retryJob(env.DB, env, Number(params.jobId));
    if (r.error) return err(r.error, r.status || 400);
    const after = await advanceJob(env.DB, env, Number(params.jobId), { onFinish: () => reallocateAll(env.DB) });
    return json({ ok: true, job: publicJob(await getJob(env.DB, Number(params.jobId))), calls: after.calls });
  }

  // ------------------------------------------------------- video review
  //
  // Same tables and helpers moderator.js uses (src/reviews.js) -- an admin
  // can review videos too, not just moderators. Nothing here ever touches
  // submissions.earning/locked_at/locked_earning/lock_reason/payment_id;
  // see src/reviews.js's own header comment.
  if (pathname === '/api/admin/review/queue' && method === 'GET') {
    return json({
      days: await reviewQueue(env.DB),
      counts: await reviewCountsToday(env.DB, { reviewerType: 'admin' })
    });
  }

  if (pathname === '/api/admin/review/reviewed' && method === 'GET') {
    return json({ reviews: await reviewedList(env.DB, { limit: Number(url.searchParams.get('limit')) || 100 }) });
  }

  if (pathname === '/api/admin/review' && method === 'POST') {
    const { submission_id, verdict, feedback } = await readJson(request);
    const result = await submitReview(env.DB, {
      submissionId: Number(submission_id), verdict, feedback,
      reviewerType: 'admin', reviewerId: null, reviewerName: 'Admin'
    });
    if (result.error) return err(result.error, result.status || 400);
    return json({ ok: true, id: result.id });
  }

  // ---------------------------------------------------------- audit log
  if (pathname === '/api/admin/audit-log' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit')) || 50;
    const beforeId = url.searchParams.get('before_id') ? Number(url.searchParams.get('before_id')) : null;
    return json({ entries: await listAuditLog(env.DB, { limit, beforeId }) });
  }

  // Diagnostic: shows every Instagram insights metric Meta will answer for one
  // clip's media, side by side, against the actual stored value. The access
  // token itself is read and used entirely server-side and never appears in
  // the response -- only the metric values Instagram returns do. Exists to
  // tell apart "our sync has a bug" from "Instagram's own API disagrees with
  // its own app" without ever having to extract a live credential by hand.
  params = matchPath('/api/admin/debug/submissions/:id/ig-metrics', pathname);
  if (params && method === 'GET') {
    const sub = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(params.id).first();
    if (!sub) return err('Not found', 404);
    if (sub.platform !== 'instagram') return err('This diagnostic is Instagram-only.', 400);
    const account = await env.DB.prepare('SELECT * FROM social_accounts WHERE id = ?').bind(sub.account_id).first();
    if (!account || !account.access_token) return err('No connected Instagram account for this clip.', 404);

    // Diagnostic calls are real Instagram calls, so they are counted against
    // the account's budget like any other. A diagnostic that spent untracked
    // quota would corrupt the exact ledger it is being used to investigate.
    const counter = makeCallCounter(account.id);
    let diag, scan = null, scanError = null, callsSpent = 0;
    try {
      diag = await debugMediaInsights(sub.ig_media_id, account.access_token, { onAttempt: counter.onAttempt });
      if (url.searchParams.get('scan') === '1' && account.external_id) {
        try {
          scan = await debugListMedia(account.external_id, account.access_token, { onAttempt: counter.onAttempt });
        } catch (e) {
          scanError = { code: e.code || 'UNKNOWN', message: e.message };
        }
      }
    } finally {
      // Read the count BEFORE flushing -- flush clears the buffer.
      callsSpent = counter.count();
      await counter.flush(env.DB);
    }

    // The specific thing worth knowing: is this clip's permalink backed by
    // more than one media id on this account? That is the API-side signature
    // of a co-authored reel, and would mean we may be holding the wrong id.
    let permalinkMatches = null;
    let duplicatePermalinks = null;
    if (scan) {
      const norm = (u) => String(u || '').split('?')[0].replace(/\/+$/, '');
      const target = norm(sub.permalink);
      permalinkMatches = scan
        .filter(m => norm(m.permalink) === target)
        .map(m => ({ id: m.id, permalink: m.permalink, timestamp: m.timestamp, like_count: m.like_count, comments_count: m.comments_count, username: m.username }));
      const byPermalink = {};
      for (const m of scan) {
        const k = norm(m.permalink);
        (byPermalink[k] = byPermalink[k] || []).push(m.id);
      }
      duplicatePermalinks = Object.entries(byPermalink)
        .filter(([, ids]) => ids.length > 1)
        .map(([permalink, ids]) => ({ permalink, media_ids: ids }));
    }

    return json({
      submission_id: sub.id,
      permalink: sub.permalink,
      stored_views: sub.views,
      stored_last_ok_sync_at: sub.last_ok_sync_at,
      stored_media_id: sub.ig_media_id,
      account_external_id: account.external_id,
      account_username: account.username,
      diagnostic_calls_spent: callsSpent,
      ...diag,
      scan_error: scanError,
      scanned_media_count: scan ? scan.length : null,
      permalink_matches: permalinkMatches,
      duplicate_permalinks: duplicatePermalinks
    });
  }

  // Media audit: everything this Instagram account has actually posted,
  // cross-checked against what ClipGrow is tracking. This answers "is every
  // video being synced?" at the only level that matters -- an UNTRACKED post
  // is invisible to every sync path there is, so no amount of refresh logic
  // would ever surface it, and the clipper silently never gets paid for it.
  params = matchPath('/api/admin/debug/accounts/:id/media-audit', pathname);
  if (params && method === 'GET') {
    const account = await env.DB.prepare('SELECT * FROM social_accounts WHERE id = ?').bind(params.id).first();
    if (!account || !account.access_token) return err('No such connected account.', 404);
    if (account.platform !== 'instagram') return err('This audit is Instagram-only.', 400);

    // Views cost one call per media, so they are opt-in. like_count alone is
    // usually enough to spot the outlier post.
    const wantInsights = url.searchParams.get('insights') === '1';
    const counter = makeCallCounter(account.id);
    let media = [], callsSpent = 0, scanError = null;
    try {
      try {
        media = await debugListMedia(account.external_id, account.access_token,
          { maxPages: 4, onAttempt: counter.onAttempt });
      } catch (e) {
        scanError = { code: e.code || 'UNKNOWN', message: e.message };
      }
      if (wantInsights) {
        for (const m of media) {
          try {
            m.views_from_api = await fetchMediaViews(m.id, account.access_token, { onAttempt: counter.onAttempt });
          } catch (e) {
            m.views_error = e.code || 'UNKNOWN';
          }
        }
      }
    } finally {
      callsSpent = counter.count();
      await counter.flush(env.DB);
    }

    const { results: subs } = await env.DB.prepare(
      'SELECT id, ig_media_id, views, status, locked_at FROM submissions WHERE account_id = ?'
    ).bind(params.id).all();
    const byMediaId = new Map((subs || []).map(s => [String(s.ig_media_id), s]));

    const rows = media.map(m => {
      const s = byMediaId.get(String(m.id));
      return {
        media_id: m.id,
        permalink: m.permalink,
        timestamp: m.timestamp,
        media_product_type: m.media_product_type,
        like_count: m.like_count,
        comments_count: m.comments_count,
        views_from_api: m.views_from_api,
        views_error: m.views_error,
        tracked: !!s,
        submission_id: s ? s.id : null,
        stored_views: s ? s.views : null
      };
    }).sort((a, b) => (b.like_count || 0) - (a.like_count || 0));

    // Tracked submissions whose media no longer appears on the account at all
    // -- i.e. deleted-and-reposted, which is exactly how a tracked clip ends
    // up frozen at a low number while the real post races ahead untracked.
    const liveIds = new Set(media.map(m => String(m.id)));
    const orphaned = (subs || [])
      .filter(s => !liveIds.has(String(s.ig_media_id)))
      .map(s => ({ submission_id: s.id, ig_media_id: s.ig_media_id, stored_views: s.views, status: s.status }));

    return json({
      account_id: account.id,
      account_username: account.username,
      diagnostic_calls_spent: callsSpent,
      scan_error: scanError,
      media_on_account: rows.length,
      tracked_count: rows.filter(r => r.tracked).length,
      untracked_count: rows.filter(r => !r.tracked).length,
      tracked_submissions_total: (subs || []).length,
      orphaned_submissions: orphaned,
      media: rows
    });
  }

  return null;
}
