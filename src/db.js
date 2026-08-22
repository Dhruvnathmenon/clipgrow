export const now = () => Date.now();

/**
 * Usernames are stored lowercase with internal whitespace removed. Creation and
 * login MUST run input through this same function, otherwise a clipper created
 * as "Dhruv" could never sign in by typing "Dhruv".
 */
export function normalizeUsername(input) {
  return String(input == null ? '' : input).trim().toLowerCase().replace(/\s+/g, '');
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

export function getCampaignById(db, id) {
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first();
}

export function getParticipation(db, clipperId, campaignId) {
  return db.prepare('SELECT * FROM participations WHERE clipper_id = ? AND campaign_id = ?')
    .bind(clipperId, campaignId).first();
}

export function getAccountById(db, id) {
  return db.prepare('SELECT * FROM social_accounts WHERE id = ?').bind(id).first();
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
export async function disconnectSocialAccount(db, accountId) {
  const account = await db.prepare('SELECT * FROM social_accounts WHERE id = ?').bind(accountId).first();
  if (!account) return null;

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

  if (pending.length) {
    const ph = pending.map(() => '?').join(',');
    stmts.push(db.prepare(`DELETE FROM submissions WHERE id IN (${ph})`).bind(...pending.map(s => s.id)));
  }

  if (settled.length) {
    // Settled clips still reference this row, so it stays -- stripped of
    // anything that could still be used to call the platform.
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
    deleted_pending: pending.length,
    kept_settled: settled.length,
    account_row_kept: settled.length > 0,
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
  'min_payout', 'max_payout', 'max_payout_per_channel',
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
export const SPEND_EXPR =
  "COALESCE(SUM(CASE WHEN locked_at IS NOT NULL THEN COALESCE(locked_earning,0) WHEN status = 'active' THEN earning ELSE 0 END), 0)";

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
export async function clipperFinancials(db, clipperId) {
  const row = await db.prepare(
    `SELECT
       ${SPEND_EXPR} AS earned,
       COALESCE(SUM(CASE WHEN locked_at IS NOT NULL THEN COALESCE(locked_earning,0) ELSE 0 END), 0) AS settled,
       COALESCE(SUM(CASE WHEN locked_at IS NULL AND status = 'active' THEN earning ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN locked_at IS NULL AND status = 'active' THEN 1 ELSE 0 END), 0) AS pending_clips
     FROM submissions WHERE clipper_id = ?`
  ).bind(clipperId).first();

  const paidRow = await db
    .prepare('SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE clipper_id = ?')
    .bind(clipperId).first();

  return {
    earned: row.earned || 0,
    settled: row.settled || 0,
    pending: row.pending || 0,
    pending_clips: row.pending_clips || 0,
    paid: paidRow.paid || 0,
    // Kept for existing callers/UI. Pending is the authoritative figure now.
    outstanding: row.pending || 0
  };
}
