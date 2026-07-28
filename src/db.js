export const now = () => Date.now();

export function getClipperByUsername(db, username) {
  return db.prepare('SELECT * FROM clippers WHERE username = ?').bind(username).first();
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
