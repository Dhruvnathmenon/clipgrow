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

export function publicCampaign(row, spent) {
  const budget = row.budget ?? 0;
  return {
    id: row.id,
    name: row.name,
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

export async function campaignSpend(db, campaignId) {
  const row = await db
    .prepare("SELECT COALESCE(SUM(earning),0) AS spent FROM submissions WHERE campaign_id = ? AND status = 'active'")
    .bind(campaignId)
    .first();
  return row.spent || 0;
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

export async function clipperFinancials(db, clipperId) {
  const earnedRow = await db
    .prepare("SELECT COALESCE(SUM(earning),0) AS earned FROM submissions WHERE clipper_id = ? AND status = 'active'")
    .bind(clipperId).first();
  const paidRow = await db
    .prepare('SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE clipper_id = ?')
    .bind(clipperId).first();
  const earned = earnedRow.earned || 0;
  const paid = paidRow.paid || 0;
  return { earned, paid, outstanding: Math.max(0, earned - paid) };
}
