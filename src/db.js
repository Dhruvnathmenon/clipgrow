import { revokeToken as revokeGoogleToken } from './youtube.js';

export const now = () => Date.now();

/**
 * Usernames are stored lowercase with internal whitespace removed. Creation and
 * login MUST run input through this same function, otherwise a clipper created
 * as "Dhruv" could never sign in by typing "Dhruv".
 */
export function normalizeUsername(input) {
  return String(input == null ? '' : input).trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * The one standard display name: the (already-normalised, all-lowercase)
 * username with its first letter capitalised. Applied automatically at
 * creation for both clippers and moderators -- there is no free-text
 * display-name field anywhere in the create forms any more, precisely so
 * this is never ambiguous. A person can still be renamed later through the
 * admin edit action; this is only ever the default a new account starts
 * with.
 */
export function defaultDisplayName(username) {
  const clean = normalizeUsername(username);
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : clean;
}

/**
 * A UPI ID is <handle>@<bank/PSP>, e.g. 9999999999@upi, name@oksbi. There is
 * no fixed registry of PSP suffixes to validate against, so this only trims
 * incidental whitespace -- the same "don't reject a real-world value over an
 * assumption" reasoning as IDENTIFIER_SPEC.youtube in access.js.
 */
export function normaliseUpiId(input) {
  return String(input == null ? '' : input).trim().replace(/\s+/g, '');
}

/**
 * Lenient on purpose, same reasoning as validateIdentifier('youtube', ...):
 * only the shape (handle@psp) is checked, never matched against a real PSP
 * list, so a clipper is never blocked by a suffix ClipGrow hasn't seen yet.
 */
export function validateUpiId(input) {
  const v = normaliseUpiId(input);
  if (!v) return 'Enter a UPI ID';
  if (!/^[\w.-]{2,256}@[A-Za-z]{2,64}$/.test(v)) {
    return 'That does not look like a UPI ID. It should look like yourname@bank, for example 9999999999@upi.';
  }
  return null;
}

/**
 * Strips everything but digits, then drops a leading '91' or '0' country/
 * trunk prefix so '+91 98765 43210', '098765 43210' and '9876543210' all
 * normalise to the same 10-digit number -- ClipGrow's clippers are all in
 * India today, and this is the shape a real WhatsApp/call number takes here.
 */
export function normaliseContactNumber(input) {
  let v = String(input == null ? '' : input).replace(/\D/g, '');
  if (v.length === 12 && v.startsWith('91')) v = v.slice(2);
  else if (v.length === 11 && v.startsWith('0')) v = v.slice(1);
  return v;
}

/**
 * Lenient on purpose, same reasoning as validateUpiId: only the shape (10
 * digits, starting 6-9 as every real Indian mobile number does) is checked,
 * not matched against a carrier registry.
 */
export function validateContactNumber(input) {
  const v = normaliseContactNumber(input);
  if (!v) return 'Enter a contact number';
  if (!/^[6-9]\d{9}$/.test(v)) {
    return 'That does not look like a 10-digit Indian mobile number.';
  }
  return null;
}

export function normaliseEmail(input) {
  return String(input == null ? '' : input).trim().toLowerCase();
}

/**
 * Lenient shape check, same spirit as validateUpiId -- catches an obviously
 * malformed entry (no @, no domain) without pretending to be a full RFC 5322
 * parser that could reject a real address it hasn't seen the shape of.
 */
export function validateEmail(input) {
  const v = normaliseEmail(input);
  if (!v) return 'Enter an email address';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    return 'That does not look like a valid email address.';
  }
  return null;
}

// Migration 039: switched from the numeric snowflake ID to the @username --
// finding Developer Mode and right-clicking to copy an ID was too much
// friction for clippers to actually do. Strips a leading "@" (people paste
// it either way) and lowercases, since Discord's own unique @username is
// always lowercase regardless of how someone types it.
export function normaliseDiscordUsername(input) {
  return String(input == null ? '' : input).trim().replace(/^@/, '').toLowerCase();
}

/**
 * Optional here (empty is valid) -- admin.js's edit endpoint relies on that
 * to let the admin clear/leave it blank on a clipper's behalf; the
 * clipper's own self-service save enforces "required" itself, at the call
 * site, same pattern as before the rename.
 */
export function validateDiscordUsername(input) {
  const v = normaliseDiscordUsername(input);
  if (!v) return null;
  if (v.length < 2 || v.length > 32 || !/^[a-z0-9_.]+$/.test(v) || v.startsWith('.') || v.endsWith('.') || v.includes('..')) {
    return 'That doesn\'t look like a Discord username -- 2-32 characters, lowercase letters/numbers/underscores/periods only. Find it under Discord Settings > My Account.';
  }
  return null;
}

export function getClipperByUsername(db, username) {
  // COLLATE NOCASE guards any row stored before normalisation existed.
  return db
    .prepare('SELECT * FROM clippers WHERE username = ? COLLATE NOCASE')
    .bind(normalizeUsername(username))
    .first();
}

export function getClipperById(db, id) {
  return db.prepare('SELECT * FROM clippers WHERE id = ?').bind(id).first();
}

export function getModeratorByUsername(db, username) {
  return db.prepare('SELECT * FROM moderators WHERE username = ? COLLATE NOCASE')
    .bind(normalizeUsername(username)).first();
}

export function getModeratorById(db, id) {
  return db.prepare('SELECT * FROM moderators WHERE id = ?').bind(id).first();
}

export function getCampaignById(db, id) {
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first();
}

export function getParticipation(db, clipperId, campaignId) {
  return db.prepare('SELECT * FROM participations WHERE clipper_id = ? AND campaign_id = ?')
    .bind(clipperId, campaignId).first();
}

/**
 * The account a participation uses on one platform, from the
 * participation_accounts join table (migration 012). A participation can hold
 * one account per platform, so a campaign can run Instagram and YouTube
 * side by side.
 */
export function getParticipationAccount(db, participationId, platform) {
  return db.prepare(
    `SELECT a.* FROM participation_accounts pa
     JOIN social_accounts a ON a.id = pa.account_id
     WHERE pa.participation_id = ? AND pa.platform = ?`
  ).bind(participationId, platform).first();
}

export async function listParticipationAccounts(db, participationId) {
  const { results } = await db.prepare(
    `SELECT a.*, pa.platform AS linked_platform FROM participation_accounts pa
     JOIN social_accounts a ON a.id = pa.account_id
     WHERE pa.participation_id = ?`
  ).bind(participationId).all();
  return results || [];
}

/**
 * Binds an account to a participation for its platform, replacing whatever was
 * linked for that platform before. participations.account_id is kept in step
 * for Instagram so any code path still reading that legacy column stays correct.
 */
export async function linkParticipationAccount(db, participationId, accountId, platform) {
  await db.prepare('DELETE FROM participation_accounts WHERE participation_id = ? AND platform = ?')
    .bind(participationId, platform).run();
  await db.prepare(
    'INSERT INTO participation_accounts (participation_id, account_id, platform, linked_at) VALUES (?, ?, ?, ?)'
  ).bind(participationId, accountId, platform, now()).run();
  if (platform === 'instagram') {
    await db.prepare('UPDATE participations SET account_id = ? WHERE id = ?').bind(accountId, participationId).run();
  }
  // Auto-reinstatement for a participation the inactivity cleanup flagged
  // (removeInactiveJoins, src/refresh-jobs.js): connecting anything at all
  // is the exact condition that would have prevented the flag in the first
  // place, so the moment it happens they're back -- no re-joining, no admin
  // action, and nothing else about the participation ever moved while
  // flagged, so there's nothing to "restore" beyond clearing this.
  await db.prepare('UPDATE participations SET inactive_at = NULL WHERE id = ? AND inactive_at IS NOT NULL')
    .bind(participationId).run();
}

/**
 * The auto-import intent an admin set at APPROVAL time (migration 016),
 * so a brand-new account defaults to it the instant it's created --
 * instead of always starting 'automatic' and needing a separate manual
 * toggle after the fact for a clipper the admin already knows posts
 * campaign work on a shared/main account. Read by instagram-auth.js and
 * youtube-auth.js at the moment a new social_accounts row is inserted;
 * an EXISTING account (a reconnect) is left exactly as it already is.
 *
 * Falls back to 1 (automatic) when there's no confirmed request to read --
 * same default social_accounts.auto_import itself has always had.
 */
export async function approvedAutoImportIntent(db, clipperId, campaignId, platform) {
  const row = await db.prepare(
    `SELECT auto_import FROM tester_requests
     WHERE clipper_id = ? AND campaign_id = ? AND platform = ? AND status = 'confirmed'
     ORDER BY requested_at DESC LIMIT 1`
  ).bind(clipperId, campaignId, platform).first();
  return row ? row.auto_import : 1;
}

export async function unlinkParticipationAccount(db, participationId, platform) {
  await db.prepare('DELETE FROM participation_accounts WHERE participation_id = ? AND platform = ?')
    .bind(participationId, platform).run();
  if (platform === 'instagram') {
    await db.prepare('UPDATE participations SET account_id = NULL WHERE id = ?').bind(participationId).run();
  }
}

/**
 * Disconnects a social account: unlinks it from every participation, deletes
 * its still-pending clips, and keeps everything already settled.
 *
 * The split is the point. A locked clip is financial history -- it was paid,
 * or formally closed at zero, and `locked_earning` is what the books say was
 * owed. It survives, and the account row survives with it, so that history
 * still resolves to a real account in exports and payout views instead of
 * dangling. Everything unlocked is only tracking data with no money committed
 * to it, so it goes, handing its share of the campaign budget back.
 *
 * Unlinking is what the old revoke-only path was missing: stripping the token
 * left the participation_accounts row in place, so the account still resolved
 * as "the account for this campaign" -- reading as connected, and blocking a
 * different account from being connected in its place.
 *
 * Returns the affected campaign ids so the caller can re-run allocation;
 * deleting pending clips changes what the remaining ones are owed.
 */
export async function disconnectSocialAccount(db, accountId, { preserveClips = false } = {}) {
  const account = await db.prepare('SELECT * FROM social_accounts WHERE id = ?').bind(accountId).first();
  if (!account) return null;

  // Actually revoke the grant on Google's side, not just null our own copy of
  // it -- see revokeToken's own comment. Instagram tokens don't have an
  // equivalent user-facing revoke endpoint in this flow, so this only applies
  // to YouTube. Best-effort and done before the local nulling below, while
  // the token this account actually held is still in hand.
  if (account.platform === 'youtube') {
    await revokeGoogleToken(account.refresh_token || account.access_token);
  }

  const { results: subs } = await db.prepare(
    'SELECT id, campaign_id, locked_at FROM submissions WHERE account_id = ?'
  ).bind(accountId).all();

  const rows = subs || [];
  const pending = rows.filter(s => !s.locked_at);
  const settled = rows.filter(s => s.locked_at);
  const campaigns = [...new Set(rows.map(s => s.campaign_id))];

  const stmts = [
    db.prepare('DELETE FROM participation_accounts WHERE account_id = ?').bind(accountId),
    db.prepare('UPDATE participations SET account_id = NULL WHERE account_id = ?').bind(accountId)
  ];

  // preserveClips keeps every submission AND the account row they point at.
  // Archiving a clipper uses it. That dialog promises "every video and payment
  // stays on record" while this function was deleting every unpaid clip --
  // destroying earned-but-unpaid money history with no undo. Only the explicit
  // single-account disconnect deletes now, and its dialog states the real
  // count and value before you confirm.
  const keepAccountRow = preserveClips || settled.length > 0;

  if (!preserveClips) {
    // ig_api_calls has a NOT NULL foreign key onto social_accounts, and every
    // Instagram view fetch writes a row. When an account has no settled clips
    // the branch below DELETEs the account outright, which that key refuses --
    // so disconnecting any Instagram account that had ever synced failed with a
    // bare "internal server error" and no way to swap the account. The rows are
    // only the rolling 200/hour rate-limit ledger, meaningless once the account
    // is gone, so they go with it.
    stmts.push(db.prepare('DELETE FROM ig_api_calls WHERE social_account_id = ?').bind(accountId));

    if (pending.length) {
      const ph = pending.map(() => '?').join(',');
      // submission_reviews carries a real NOT NULL FK onto submissions
      // (migration 023, added after this function was first written) --
      // the moderator/admin video-review workflow. A reviewed pending clip
      // would otherwise make the DELETE below fail outright, the same class
      // of bug the ig_api_calls comment above already covers for a
      // different table. The review verdict has no meaning once the clip
      // it was about no longer exists, so it goes with it.
      stmts.push(db.prepare(`DELETE FROM submission_reviews WHERE submission_id IN (${ph})`).bind(...pending.map(s => s.id)));
      stmts.push(db.prepare(`DELETE FROM submissions WHERE id IN (${ph})`).bind(...pending.map(s => s.id)));
    }
  }

  if (keepAccountRow) {
    // Clips still reference this row, so it stays -- stripped of anything that
    // could still be used to call the platform.
    stmts.push(db.prepare(
      "UPDATE social_accounts SET status='revoked', access_token=NULL, refresh_token=NULL, token_expires_at=NULL WHERE id = ?"
    ).bind(accountId));
  } else {
    stmts.push(db.prepare('DELETE FROM social_accounts WHERE id = ?').bind(accountId));
  }

  await db.batch(stmts);

  return {
    platform: account.platform,
    username: account.username,
    deleted_pending: preserveClips ? 0 : pending.length,
    preserved_pending: preserveClips ? pending.length : 0,
    kept_settled: settled.length,
    account_row_kept: keepAccountRow,
    campaigns
  };
}

/**
 * Whether this external account is already driving a different LIVE campaign.
 *
 * Checked across every clipper, not just the one connecting, so two logins
 * cannot quietly point at the same account. Completed campaigns, kicked
 * participations and revoked accounts are excluded, which is what frees a
 * good account up for reuse on the next campaign.
 */
export function findAccountClash(db, externalId, platform, campaignId) {
  return db.prepare(
    `SELECT c.name AS campaign_name, p.clipper_id, cl.username AS clipper_username
     FROM participation_accounts pa
     JOIN social_accounts a ON a.id = pa.account_id
     JOIN participations p ON p.id = pa.participation_id
     JOIN campaigns c ON c.id = p.campaign_id
     JOIN clippers cl ON cl.id = p.clipper_id
     WHERE a.external_id = ? AND a.platform = ?
       AND p.campaign_id != ?
       AND p.status != 'kicked'
       AND a.status != 'revoked'
       AND c.status != 'completed'`
  ).bind(externalId, platform, campaignId).first();
}

/**
 * Whether a connected account has a real OPEN problem right now, given raw
 * status/error/mismatch fields plus the two acknowledgment columns
 * (migration 023 -- see that migration's own header for why these are
 * "what was true at the moment of acknowledgment", not a plain dismissed-
 * forever boolean).
 *
 * The single source of truth for this -- GET /api/admin/accounts (the
 * bucketed Issues/Active/Paused/Removed panel) and GET /api/admin/clippers
 * (the roster's "⚠ mismatch" / "N issue" badges) both call this instead of
 * each keeping their own copy. They used to disagree: the roster's copy was
 * a raw SQL check with no idea the acknowledgment columns existed, so
 * unflagging something in the Issues panel never cleared the badge above it.
 *
 * `a` needs: username, status, last_error_code, last_error_at,
 * mismatch_approved_as (the tester_requests-derived identifier, computed by
 * the caller's own SQL -- it needs a JOIN this function doesn't have),
 * mismatch_acknowledged_as, error_acknowledged_at.
 */
export function accountIssues(a) {
  const mismatchOpen = !!a.mismatch_approved_as && a.username !== a.mismatch_acknowledged_as;
  const importFailing = a.status === 'connected' && /^IMPORT_/.test(a.last_error_code || '');
  // Suppressed only while we have positive proof the current error predates
  // the acknowledgment. Missing last_error_at fails OPEN -- never silently
  // hide a problem this can't actually rule out.
  const errorPredatesAck = !!a.error_acknowledged_at && !!a.last_error_at && a.last_error_at <= a.error_acknowledged_at;
  const errorOpen = (a.status === 'needs_reauth' || importFailing) && !errorPredatesAck;
  return { mismatchOpen, errorOpen };
}

// ---------------------------------------------------------------- shaping

export function publicClipper(row) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name || row.username,
    status: row.status,
    created_at: row.created_at
  };
}

/** Never leaks access tokens. */
export function publicAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    username: row.username,
    account_type: row.account_type,
    status: row.status,
    last_error_code: row.last_error_code,
    expires_at: row.token_expires_at,
    connected_at: row.connected_at,
    // false = this account only tracks videos the clipper pastes in by hand
    // (migration 015). The clipper needs to know, or they will assume their
    // posts are being picked up automatically and quietly earn nothing.
    auto_import: row.auto_import !== 0
  };
}

export const BLUEPRINT_FIELDS = [
  'title', 'socials', 'objective', 'cta', 'tags', 'platforms',
  'guidelines', 'footage', 'demo_video', 'model_note', 'commission_rate',
  // max_payout is the per-video ceiling and is the only payout field the
  // allocator enforces. min_payout and max_payout_per_channel used to sit here
  // too: the first duplicated campaigns.min_views (the real, enforced views
  // threshold) and the second was never consulted by any money code, so both
  // were decorative -- shown to clippers and brands as if they were binding.
  'max_payout',
  'approval_steps', 'terms', 'extra_fields'
];

export function pickBlueprint(payload) {
  const out = {};
  for (const key of BLUEPRINT_FIELDS) {
    if (payload[key] !== undefined) out[key] = payload[key];
  }
  return out;
}

function safeParse(json) {
  if (!json) return {};
  try {
    return JSON.parse(json) || {};
  } catch {
    return {};
  }
}

/**
 * URL-friendly slug for a campaign's public page. Lowercased, hyphenated,
 * stripped of anything non-alphanumeric. Collisions (same name reused) are
 * resolved by appending the campaign id, since ids are already unique and
 * stable -- avoids a lookup-and-retry loop at creation time.
 */
export function slugify(name, id) {
  const base = String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return id ? `${base || 'campaign'}-${id}` : (base || 'campaign');
}

export function publicCampaign(row, spent) {
  const budget = row.budget ?? 0;
  return {
    id: row.id,
    name: row.name,
    allowed_platforms: String(row.allowed_platforms || 'instagram').split(',').filter(Boolean),
    slug: row.slug || null,
    description: row.description,
    cpm: row.cpm,
    min_views: row.min_views == null ? 0 : row.min_views,
    budget: row.budget,
    spent: spent ?? 0,
    remaining: Math.max(0, budget - (spent ?? 0)),
    status: row.status,
    // Only meaningful once status is 'completed' -- whether the clipper-
    // facing "campaign ended" recap card still shows (NULL) or the founder
    // has dismissed it for everyone (set).
    recap_hidden_at: row.recap_hidden_at || null,
    model: row.model || '',
    created_at: row.created_at,
    blueprint: safeParse(row.blueprint_json)
  };
}

/**
 * Budget consumed by a campaign.
 *
 * A locked clip counts its settled amount no matter what its status later
 * becomes: that money genuinely left the account, so it cannot be un-spent by
 * disqualifying the clip afterwards. Only unlocked clips are contingent on
 * still being 'active'.
 */
export function spendExpr(alias = '') {
  const p = alias ? alias + '.' : '';
  return `COALESCE(SUM(CASE WHEN ${p}locked_at IS NOT NULL THEN COALESCE(${p}locked_earning,0) ` +
         `WHEN ${p}status = 'active' THEN ${p}earning ELSE 0 END), 0)`;
}

export const SPEND_EXPR = spendExpr();

/**
 * The clipper's real total, historical -- what they've actually been paid
 * (settled) plus what they're currently owed (pending), never the billable
 * figure SPEND_EXPR gives. Same shape as spendExpr, with clipper_earning in
 * place of earning for the unlocked branch (the locked branch is identical:
 * locked_earning is already the clipper's real settled amount, see
 * src/payouts.js's settlePayment).
 *
 * SPEND_EXPR answers "how much campaign budget has this delivered" (an
 * admin/client question -- budget consumption is fundamentally billable,
 * see the Non-negotiables in the fractional-margin plan). This answers "how
 * much has this clipper actually earned" -- a clipper-facing screen must
 * never show the billable figure as if it were their own money.
 */
export function spendClipperExpr(alias = '') {
  const p = alias ? alias + '.' : '';
  return `COALESCE(SUM(CASE WHEN ${p}locked_at IS NOT NULL THEN COALESCE(${p}locked_earning,0) ` +
         `WHEN ${p}status = 'active' THEN ${p}clipper_earning ELSE 0 END), 0)`;
}

export const SPEND_CLIPPER_EXPR = spendClipperExpr();

/**
 * What's still owed to the clipper on an UNLOCKED, active clip -- the
 * "pending" half of clipperFinancials, factored out because it was being
 * hand-written independently in four places (db.js's totalOutstanding and
 * clipperFinancials, admin.js's unpaid_value and campaign-participants
 * query) after the earning_math split, which is exactly the "same number,
 * computed in several places, only some get updated" bug class this
 * project has already hit twice (the roster/Issues badges, the refresh
 * budget). One function now, reused everywhere.
 */
export function pendingClipperExpr(alias = '') {
  const p = alias ? alias + '.' : '';
  return `COALESCE(SUM(CASE WHEN ${p}locked_at IS NULL AND ${p}status = 'active' THEN ${p}clipper_earning ELSE 0 END), 0)`;
}

export const PENDING_CLIPPER_EXPR = pendingClipperExpr();

export async function campaignSpend(db, campaignId) {
  const row = await db
    .prepare(`SELECT ${SPEND_EXPR} AS spent FROM submissions WHERE campaign_id = ?`)
    .bind(campaignId)
    .first();
  return row.spent || 0;
}

/**
 * Per-video earnings ceiling for a campaign, from its blueprint. Zero means
 * uncapped. Parsed defensively because blueprints are extracted from Word
 * documents, so the value can arrive as a string like "5000" or be absent.
 */
export function maxPayoutPerVideo(campaignRow) {
  const bp = safeParse(campaignRow && campaignRow.blueprint_json);
  const raw = Number(bp.max_payout);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export async function campaignWithSpend(db, row) {
  return publicCampaign(row, await campaignSpend(db, row.id));
}

// ---------------------------------------------------------------- money

/**
 * Earned comes from active submissions; received comes from the payments
 * ledger. Outstanding is the difference, floored at zero so an overpayment
 * never renders as a negative balance.
 */
// Day boundaries are evaluated in IST so a clipper posting at 11pm local time
// doesn't silently break their streak.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// A clipper counts as "active" -- as opposed to merely "joined" -- if they've
// posted within this window. Joining a campaign is one click and says nothing
// about whether someone is actually doing the work; a recent real post
// (COALESCE(posted_at, created_at), same reasoning as the streak below: the
// platform post date, never ClipGrow's import time) is the actual signal.
export const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function istDayNumber(ts) {
  return Math.floor((Number(ts) + IST_OFFSET_MS) / 86400000);
}

/**
 * Consecutive-day posting streak. A streak stays alive if the clipper posted
 * today or yesterday; anything older has lapsed and reads as zero.
 */
/**
 * Streak maths for one clipper's posting timestamps.
 *
 * MUST be fed the time a clip was POSTED on the platform, never the time
 * ClipGrow imported it. Import lag is real and large -- auto-import runs on a
 * six-hourly cron and has historically backed up for days, so one import pass
 * can land a week of uploads at a single instant. Measured on import time, a
 * clipper posting reliably every day reads as a broken streak, and a backlog
 * flush collapses several days of work into one. Hence COALESCE(posted_at,
 * created_at) at every call site: posted_at is the truth, created_at is only
 * a fallback for rows that predate it being recorded.
 */
function streakFromTimestamps(timestamps) {
  if (!timestamps || !timestamps.length) {
    return { current: 0, best: 0, last_post_at: null, days_since_last_post: null };
  }

  const days = [...new Set(timestamps.map(istDayNumber))].sort((a, b) => b - a);
  const today = istDayNumber(Date.now());

  // A streak survives today OR yesterday: someone who has not posted yet today
  // has not broken anything, they just have not posted yet today.
  let current = 0;
  if (days[0] === today || days[0] === today - 1) {
    current = 1;
    for (let i = 1; i < days.length; i++) {
      if (days[i - 1] - days[i] === 1) current++;
      else break;
    }
  }

  let best = 1, run = 1;
  for (let i = 1; i < days.length; i++) {
    if (days[i - 1] - days[i] === 1) run++;
    else run = 1;
    if (run > best) best = run;
  }

  const lastPostAt = Math.max(...timestamps);
  return {
    current,
    best,
    last_post_at: lastPostAt,
    // Whole IST days since the last post: 0 = today, 1 = yesterday. Derived
    // from day boundaries rather than elapsed hours, so "yesterday" means
    // yesterday's date rather than "between 24 and 48 hours ago".
    days_since_last_post: today - istDayNumber(lastPostAt)
  };
}

/**
 * Consecutive-day posting streak. A streak stays alive if the clipper posted
 * today or yesterday; anything older has lapsed and reads as zero.
 */
export async function clipperStreak(db, clipperId) {
  const { results } = await db
    .prepare(`SELECT COALESCE(posted_at, created_at) AS ts
              FROM submissions WHERE clipper_id = ? AND status = 'active'`)
    .bind(clipperId).all();
  return streakFromTimestamps((results || []).map(r => Number(r.ts)));
}

/**
 * Streaks for every active clipper in ONE query.
 *
 * The directory ranks everyone at once, so doing this per clipper would mean a
 * query per row -- fine at five clippers, a problem at fifty. One scan grouped
 * in memory keeps the leaderboard a fixed cost regardless of roster size.
 */
export async function allClipperStreaks(db) {
  const { results } = await db.prepare(
    `SELECT s.clipper_id, COALESCE(s.posted_at, s.created_at) AS ts
     FROM submissions s
     JOIN clippers cl ON cl.id = s.clipper_id
     WHERE s.status = 'active' AND cl.status = 'active'`
  ).all();

  const byClipper = new Map();
  for (const r of results || []) {
    if (!byClipper.has(r.clipper_id)) byClipper.set(r.clipper_id, []);
    byClipper.get(r.clipper_id).push(Number(r.ts));
  }

  const out = new Map();
  for (const [id, stamps] of byClipper) out.set(id, streakFromTimestamps(stamps));
  return out;
}

export async function clipperTotals(db, clipperId) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS clips, COALESCE(SUM(views),0) AS views
     FROM submissions WHERE clipper_id = ? AND status = 'active'`
  ).bind(clipperId).first();
  return { clips: row.clips || 0, views: row.views || 0 };
}

/**
 * Money for one clipper.
 *
 * `pending` is the number that actually matters at payout time: everything
 * earned on clips that have not been locked yet. It is derived straight from
 * the clips rather than from `earned - paid`, so a rounding difference between
 * what was owed and what was actually transferred can never silently roll into
 * the next payout.
 */
/**
 * What the agency owes every clipper, added up.
 *
 * Deliberately the SUM of each clipper's own `owed` -- max(0, pending -
 * unrecovered advances) -- with the floor applied PER CLIPPER, so it agrees
 * with clipperFinancials() row for row. A single global expression cannot:
 * flooring once at the end nets one clipper's payments against another
 * clipper's unpaid earnings, which is exactly what the admin Overview used to
 * do. Lives here, next to the rule it mirrors, so the two cannot drift.
 */
export async function totalOutstanding(db) {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(MAX(0, owed)), 0) AS outstanding FROM (
       SELECT COALESCE(sub.pending, 0) - COALESCE(pay.advanced, 0) AS owed
         FROM clippers cl
         LEFT JOIN (SELECT clipper_id, ${pendingClipperExpr()} AS pending
                      FROM submissions GROUP BY clipper_id) sub ON sub.clipper_id = cl.id
         LEFT JOIN (SELECT clipper_id,
                           SUM(CASE WHEN kind = 'advance' THEN amount - COALESCE(recovered_amount,0) ELSE 0 END) AS advanced
                      FROM payments GROUP BY clipper_id) pay ON pay.clipper_id = cl.id
     )`
  ).first();
  return row.outstanding || 0;
}

export async function clipperFinancials(db, clipperId) {
  const row = await db.prepare(
    `SELECT
       ${SPEND_EXPR} AS earned,
       ${SPEND_CLIPPER_EXPR} AS clipper_earned,
       COALESCE(SUM(CASE WHEN locked_at IS NOT NULL THEN COALESCE(locked_earning,0) ELSE 0 END), 0) AS settled,
       ${PENDING_CLIPPER_EXPR} AS pending,
       COALESCE(SUM(CASE WHEN locked_at IS NULL AND status = 'active' THEN 1 ELSE 0 END), 0) AS pending_clips
     FROM submissions WHERE clipper_id = ?`
  ).bind(clipperId).first();

  const paidRow = await db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS paid,
            COALESCE(SUM(CASE WHEN kind = 'advance' THEN amount - COALESCE(recovered_amount,0) ELSE 0 END),0) AS advanced,
            COALESCE(SUM(CASE WHEN kind = 'bonus'   THEN amount ELSE 0 END),0) AS bonuses
     FROM payments WHERE clipper_id = ?`
  ).bind(clipperId).first();

  const pending = row.pending || 0;
  const advanced = paidRow.advanced || 0;

  return financialsShape(row, paidRow);
}

/** The exact object clipperFinancials returns, from a submissions-agg row and a
 *  payments-agg row (either may be a partial/empty object). Factored out so the
 *  per-clipper path and the whole-roster path below cannot drift. */
function financialsShape(row, paidRow) {
  const pending = (row && row.pending) || 0;
  const advanced = (paidRow && paidRow.advanced) || 0;
  return {
    earned: (row && row.earned) || 0,
    clipper_earned: (row && row.clipper_earned) || 0,
    settled: (row && row.settled) || 0,
    pending,
    pending_clips: (row && row.pending_clips) || 0,
    paid: (paidRow && paidRow.paid) || 0,
    advanced,
    bonuses: (paidRow && paidRow.bonuses) || 0,
    owed: Math.max(0, pending - advanced)
  };
}

/**
 * clipperFinancials for EVERY clipper in two queries instead of ~three per
 * row. The roster ranks the whole list at once, so the per-clipper version was
 * a fixed multiplier on page-load latency -- ~six queries times the roster
 * size -- and, past a few dozen clippers, a real risk of tripping D1's
 * per-request statement ceiling. Same "one grouped scan" fix already applied
 * to allClipperStreaks. Returns Map<clipperId, sameShapeAsClipperFinancials>.
 */
export async function allClipperFinancials(db) {
  const [{ results: subRows }, { results: payRows }] = await Promise.all([
    db.prepare(
      `SELECT clipper_id,
         ${spendExpr()} AS earned,
         ${spendClipperExpr()} AS clipper_earned,
         COALESCE(SUM(CASE WHEN locked_at IS NOT NULL THEN COALESCE(locked_earning,0) ELSE 0 END), 0) AS settled,
         ${pendingClipperExpr()} AS pending,
         COALESCE(SUM(CASE WHEN locked_at IS NULL AND status = 'active' THEN 1 ELSE 0 END), 0) AS pending_clips
       FROM submissions GROUP BY clipper_id`
    ).all(),
    db.prepare(
      `SELECT clipper_id,
         COALESCE(SUM(amount),0) AS paid,
         COALESCE(SUM(CASE WHEN kind = 'advance' THEN amount - COALESCE(recovered_amount,0) ELSE 0 END),0) AS advanced,
         COALESCE(SUM(CASE WHEN kind = 'bonus'   THEN amount ELSE 0 END),0) AS bonuses
       FROM payments GROUP BY clipper_id`
    ).all()
  ]);
  const subs = new Map((subRows || []).map(r => [r.clipper_id, r]));
  const pays = new Map((payRows || []).map(r => [r.clipper_id, r]));
  const out = new Map();
  for (const id of new Set([...subs.keys(), ...pays.keys()])) {
    out.set(id, financialsShape(subs.get(id), pays.get(id)));
  }
  return out;
}

/** The all-zero financials shape, for a clipper with no clips and no payments. */
export const EMPTY_FINANCIALS = financialsShape(null, null);
