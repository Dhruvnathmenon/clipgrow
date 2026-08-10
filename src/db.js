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
    connected_at: row.connected_at
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
export async function clipperStreak(db, clipperId) {
  const { results } = await db
    .prepare("SELECT created_at FROM submissions WHERE clipper_id = ? AND status = 'active' ORDER BY created_at DESC")
    .bind(clipperId).all();
  if (!results || !results.length) return { current: 0, best: 0, last_post_at: null };

  const days = [...new Set(results.map(r => istDayNumber(r.created_at)))].sort((a, b) => b - a);
  const today = istDayNumber(Date.now());

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

  return { current, best, last_post_at: results[0].created_at };
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
