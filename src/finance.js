// Agency-level money. Everything else in this system answers "what do we owe
// clippers"; this answers "have we been paid, what did we spend, are we cash
// positive, what has the agency actually earned, and what does it owe me".
//
// THE TWO POTS, and why they are not interchangeable:
//
//   agency    The working account. The clipper share of every client payment
//             lands here; clipper payouts and running costs leave from here.
//             Empty means clippers cannot be paid.
//   clipgrow  ClipGrow's own earned money -- the management-fee share of each
//             client payment. Kept apart so fee income is never mistaken for
//             money that is really owed to clippers.
//
// Only two, on purpose. The founder's own money is deliberately NOT a pot: the
// agency does not fund client campaigns out of anyone's pocket. That is a
// decision, not an omission -- fronting a client's delivery makes you their
// bank, taking financing risk for no financing return, and it is how a
// profitable agency runs out of cash. The capital_in / capital_repayment
// categories still exist because heyschool WAS funded that way before the
// system did, and history has to be recordable. Nothing new should use them.
//
// PROFIT AND CASH ARE DIFFERENT QUESTIONS and are reported separately. The
// client's 100% passes through to clippers and is not our cost, so profit is
// fees minus operating costs. But the founder pays clippers before the client
// pays him, so a profitable month can leave the account empty. Collapsing the
// two into one number is the failure this module exists to prevent.

import { campaignSpend } from './db.js';

export const WALLET_KINDS = ['agency', 'clipgrow'];

// Clippers and clients always see the FULL campaign budget and its limits. This
// wallet split is internal bookkeeping only -- it never changes a public number.

export const LEDGER_CATEGORIES = [
  'client_payment',     // in  — the clipper share of a client payment
  'clipper_payout',     // out — money reaching a clipper
  'management_fee',     // in  — ClipGrow's share of a client payment
  'capital_in',         // in  — a founder putting their own money in
  'capital_repayment',  // out — paying a founder back
  'refund',             // out — returning unconsumed money to a client
  'tool',               // out — software, subscriptions
  'ads',                // out — paid promotion
  'other'               // out — anything else, with a note explaining it
];

/** Categories that are a real operating cost to the agency. */
export const COST_CATEGORIES = ['tool', 'ads', 'other'];

const DIRECTIONS = ['in', 'out'];

/**
 * A transfer is ONE row: direction 'out', `wallet_id` the source,
 * `transfer_wallet_id` the destination. So a wallet's balance is what came in,
 * less what went out, plus anything transferred to it.
 */
const BALANCE_SQL = `
  COALESCE(SUM(CASE WHEN le.wallet_id = w.id AND le.direction = 'in'  THEN le.amount ELSE 0 END), 0)
- COALESCE(SUM(CASE WHEN le.wallet_id = w.id AND le.direction = 'out' THEN le.amount ELSE 0 END), 0)
+ COALESCE(SUM(CASE WHEN le.transfer_wallet_id = w.id                 THEN le.amount ELSE 0 END), 0)`;

/** Every wallet with its balance. Voided entries never count. */
export async function walletBalances(db) {
  const { results } = await db.prepare(
    `SELECT w.id, w.name, w.kind, w.owner, w.client_id, w.status,
            ${BALANCE_SQL} AS balance
       FROM wallets w
       LEFT JOIN ledger_entries le
         ON (le.wallet_id = w.id OR le.transfer_wallet_id = w.id)
        AND le.status = 'active'
      GROUP BY w.id
      ORDER BY CASE w.kind WHEN 'agency' THEN 0 WHEN 'personal' THEN 1 ELSE 2 END, w.name`
  ).all();
  return (results || []).map(w => ({ ...w, balance: w.balance || 0 }));
}

export async function getWallet(db, id) {
  return db.prepare('SELECT * FROM wallets WHERE id = ?').bind(id).first();
}

export async function walletByName(db, name) {
  return db.prepare('SELECT * FROM wallets WHERE name = ?').bind(name).first();
}

/** The two fixed pots, by kind. */
export async function walletOfKind(db, kind) {
  return db.prepare("SELECT * FROM wallets WHERE kind = ? AND status = 'active' ORDER BY id LIMIT 1")
    .bind(kind).first();
}

/**
 * Splits an arriving client payment the way the money is actually meant.
 *
 * The client commits 120% of the campaign budget: 100% for clippers, 20% fee.
 * So of any amount they send, 100/120 is clipper money and 20/120 is ours.
 * Recorded as two linked entries rather than one, because the whole point is
 * being able to say which rupees are whose.
 *
 * The fee is taken on RECEIPT, not on delivery. That is deliberate and has a
 * consequence the refund path handles: stop a campaign early and some of the
 * fee taken was never earned, so it is clawed back out of the agency wallet.
 */
export async function recordClientPayment(db, {
  clientId, campaignId, amount, feePercent = 20,
  method = null, reference = null, note = null, occurredAt = null, createdBy = 'admin'
}) {
  const total = Math.round(Number(amount));
  if (!Number.isFinite(total) || total <= 0) {
    return { error: 'Amount must be a positive number.', status: 400 };
  }
  const agency = await walletOfKind(db, 'agency');
  const clipgrow = await walletOfKind(db, 'clipgrow');
  if (!agency || !clipgrow) return { error: 'Wallets are not set up.', status: 500 };

  // fee share = feePercent / (100 + feePercent). At 20% that is 1/6 of what
  // arrives, leaving 5/6 for clippers -- 8,000 and 40,000 out of 48,000.
  const fee = Math.round((total * feePercent) / (100 + feePercent));
  const poolShare = total - fee;
  const at = occurredAt || Date.now();
  const common = { client_id: clientId || null, campaign_id: campaignId || null,
                   method, reference, occurred_at: at, created_by: createdBy };

  const a = await addEntry(db, {
    ...common, direction: 'in', amount: poolShare, wallet_id: agency.id,
    category: 'client_payment',
    note: note ? `${note} — clipper share` : 'Client payment — clipper share'
  });
  if (a.error) return a;

  const b = fee > 0 ? await addEntry(db, {
    ...common, direction: 'in', amount: fee, wallet_id: clipgrow.id,
    category: 'management_fee',
    note: note ? `${note} — ${feePercent}% fee` : `Management fee (${feePercent}%)`
  }) : { ok: true };
  if (b.error) return b;

  return { ok: true, total, pool_share: poolShare, fee, pool_entry: a.id, fee_entry: b.id || null };
}

/**
 * Historical only: money a founder put in before the agency funded itself.
 * Kept so heyschool's real history can be recorded; nothing new should add to
 * it. If this is above zero and rising, the no-personal-money rule has slipped.
 */
export async function founderOwed(db) {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN category = 'capital_in'        THEN amount ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN category = 'capital_repayment' THEN amount ELSE 0 END), 0) AS owed
       FROM ledger_entries WHERE status = 'active'`
  ).first();
  return Math.max(0, (row && row.owed) || 0);
}

/**
 * What is actually in the agency wallet right now.
 *
 * This is the gate on paying clippers: you cannot send money you do not have,
 * and the whole reason fee income sits in a separate wallet is so it cannot
 * quietly make this number look bigger than it is.
 */
export async function agencyAvailable(db) {
  const wallets = await walletBalances(db);
  const w = wallets.find(x => x.kind === 'agency');
  return w ? w.balance : 0;
}

/** Clipper money received for one campaign, for the refund arithmetic. */
export async function poolHeld(db, { campaignId = null } = {}) {
  const received = await sumEntries(db, { direction: 'in', categories: ['client_payment'], campaignId });
  const paidOut = await sumEntries(db, { direction: 'out', categories: ['clipper_payout'], campaignId });
  return received - paidOut;
}

/** Sum of active ledger entries matching a filter. Internal helper. */
async function sumEntries(db, { direction = null, categories = null, campaignId = null,
                                clientId = null, from = null, to = null } = {}) {
  const where = ["status = 'active'"];
  const args = [];
  if (direction) { where.push('direction = ?'); args.push(direction); }
  if (categories && categories.length) {
    where.push(`category IN (${categories.map(() => '?').join(',')})`);
    args.push(...categories);
  }
  if (campaignId != null) { where.push('campaign_id = ?'); args.push(campaignId); }
  if (clientId != null) { where.push('client_id = ?'); args.push(clientId); }
  if (from != null) { where.push('occurred_at >= ?'); args.push(from); }
  if (to != null) { where.push('occurred_at <= ?'); args.push(to); }

  const row = await db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM ledger_entries WHERE ${where.join(' AND ')}`
  ).bind(...args).first();
  return (row && row.total) || 0;
}

/**
 * One campaign's commercial position.
 *
 * delivered   what clippers have actually earned (reuses campaignSpend, so it
 *             can never disagree with the allocator)
 * fee         fee_percent of delivered. Internal campaigns earn nothing.
 * obligation  delivered + fee -- what the client actually owes for work done
 * paid        what the client has actually sent for this campaign
 * balance     paid - obligation. Positive = refund due. Negative = shortfall.
 *
 * At the moment a campaign is stopped, `balance` IS the refund cheque, and it
 * equals the money still held for that campaign. Two routes to the same number.
 */
export async function campaignFinancials(db, campaignId) {
  const campaign = await db.prepare(
    'SELECT id, name, budget, fee_percent, campaign_kind, client_id, status, notice_at, notice_ends_at, closed_at FROM campaigns WHERE id = ?'
  ).bind(campaignId).first();
  if (!campaign) return null;

  const internal = campaign.campaign_kind === 'internal';
  const delivered = await campaignSpend(db, campaignId);
  const feePercent = internal ? 0 : Number(campaign.fee_percent || 0);

  // What we have EARNED by delivering work.
  const feeEarned = Math.round((delivered * feePercent) / 100);
  const obligation = internal ? 0 : delivered + feeEarned;

  // What actually arrived, split the way it was recorded.
  const poolReceived = internal ? 0 : await sumEntries(db, {
    direction: 'in', categories: ['client_payment'], campaignId
  });
  const feeTaken = internal ? 0 : await sumEntries(db, {
    direction: 'in', categories: ['management_fee'], campaignId
  });
  const refunded = internal ? 0 : await sumEntries(db, {
    direction: 'out', categories: ['refund'], campaignId
  });

  const clientPaid = poolReceived + feeTaken - refunded;

  // The refund, decomposed the way the money physically has to move:
  //   whatever is left of the clipper pool for this campaign,
  //   PLUS fee we took on receipt but never earned by delivering.
  // The second half is why taking the fee up front has a cost -- it has to come
  // back out of the agency wallet, not the pool.
  const unspentPool = Math.max(0, poolReceived - delivered);
  const unearnedFee = Math.max(0, feeTaken - feeEarned);
  const refundDue = internal ? 0 : unspentPool + unearnedFee;

  // Owed to us: delivered work the client has not covered.
  const shortfall = internal ? 0 : Math.max(0, obligation - clientPaid);

  return {
    campaign_id: campaign.id,
    name: campaign.name,
    client_id: campaign.client_id,
    is_internal: internal,
    budget: campaign.budget || 0,
    delivered,
    fee_percent: feePercent,
    fee_earned: feeEarned,
    fee_taken: feeTaken,
    unearned_fee: unearnedFee,
    pool_received: poolReceived,
    unspent_pool: unspentPool,
    // An internal campaign is ClipGrow's own marketing: nobody bills for it, so
    // the money paid to clippers is a straight cost rather than pass-through.
    cost: internal ? delivered : 0,
    client_obligation: obligation,
    client_paid: clientPaid,
    balance: internal ? 0 : clientPaid - obligation,
    refund_due: refundDue,
    shortfall,
    status: campaign.status,
    notice_at: campaign.notice_at,
    notice_ends_at: campaign.notice_ends_at,
    closed_at: campaign.closed_at
  };
}

/** Every campaign's position, for the P&L table. */
export async function allCampaignFinancials(db) {
  const { results } = await db.prepare('SELECT id FROM campaigns ORDER BY created_at DESC').all();
  const out = [];
  for (const c of results || []) out.push(await campaignFinancials(db, c.id));
  return out.filter(Boolean);
}

/**
 * The agency's own position.
 *
 * fees_earned    accrual: what we have earned by delivering work, whether or
 *                not the client has paid it yet
 * fees_collected cash: what has actually reached the agency wallet
 * costs          operating spend, INCLUDING clipper payouts on internal
 *                campaigns, which no client funds
 * profit         fees_earned - costs
 * cash_position  what is actually in agency + personal wallets right now
 *
 * profit and cash_position are returned side by side and may disagree in sign.
 * That is the point.
 */
export async function agencyPnL(db, { from = null, to = null } = {}) {
  const campaigns = await allCampaignFinancials(db);

  const feesEarned = campaigns.reduce((n, c) => n + (c.fee_earned || 0), 0);
  const internalCost = campaigns.reduce((n, c) => n + (c.cost || 0), 0);
  const clientObligation = campaigns.reduce((n, c) => n + (c.client_obligation || 0), 0);
  const clientPaid = campaigns.reduce((n, c) => n + (c.client_paid || 0), 0);

  const feesCollected = await sumEntries(db, { direction: 'in', categories: ['management_fee'], from, to });
  const directCosts = await sumEntries(db, { direction: 'out', categories: COST_CATEGORIES, from, to });

  const wallets = await walletBalances(db);
  const agencyBalance = wallets.filter(w => w.kind === 'agency').reduce((n, w) => n + w.balance, 0);
  const clipgrowBalance = wallets.filter(w => w.kind === 'clipgrow').reduce((n, w) => n + w.balance, 0);

  const moneyIn = await sumEntries(db, { direction: 'in', from, to });
  const moneyOut = await sumEntries(db, { direction: 'out', from, to });
  const costs = directCosts + internalCost;

  return {
    fees_earned: feesEarned,
    fees_collected: feesCollected,
    costs,
    direct_costs: directCosts,
    internal_campaign_cost: internalCost,
    profit: feesEarned - costs,

    // Cash is a separate question from profit, and both are reported.
    agency_balance: agencyBalance,
    clipgrow_balance: clipgrowBalance,
    cash_position: agencyBalance + clipgrowBalance,
    // Historical only; should stay at zero now the agency funds itself.
    founder_owed: await founderOwed(db),
    // Delivered work no client money covers yet -- the number that decides
    // whether Sunday's payout run can actually happen.
    unfunded_delivery: (await fundingAlerts(db)).reduce((n, f) => n + f.unfunded, 0),
    // Clipper money received that has not reached a clipper yet.
    unpaid_clipper_money: await poolHeld(db, {}),

    money_in: moneyIn,
    money_out: moneyOut,
    net_flow: moneyIn - moneyOut,

    // Delivered work the client has not paid for yet.
    receivable: Math.max(0, clientObligation - clientPaid)
  };
}

/**
 * Are we delivering faster than we are being paid?
 *
 * The whole reason not to fund campaigns personally is that it converts a
 * collection problem into a cash problem. Take the funding away and the
 * collection problem is still there -- it just lands on the clippers instead.
 * So it has to be visible EARLY: collection takes days and clippers post daily,
 * which is why the warning fires at 70% of collected funds consumed rather than
 * at zero.
 */
export const FUNDING_WARN_AT = 0.7;

export async function campaignFunding(db, campaignId) {
  const fin = await campaignFinancials(db, campaignId);
  if (!fin || fin.is_internal) return null;

  const collected = fin.pool_received;                 // clipper money actually received
  const delivered = fin.delivered;                     // clipper money already earned
  const headroom = collected - delivered;
  const used = collected > 0 ? delivered / collected : (delivered > 0 ? Infinity : 0);

  return {
    campaign_id: fin.campaign_id,
    name: fin.name,
    budget: fin.budget,
    collected,
    delivered,
    headroom,
    used_ratio: used,
    // Unfunded delivery: work already earned that no client money covers.
    // Clippers are owed it whether or not the client has paid.
    unfunded: Math.max(0, -headroom),
    // Ask for the next tranche NOW, not when it hits zero.
    should_invoice: used >= FUNDING_WARN_AT,
    critical: headroom <= 0
  };
}

export async function fundingAlerts(db) {
  const { results } = await db.prepare(
    "SELECT id FROM campaigns WHERE status IN ('active','budget_full','closing')"
  ).all();
  const out = [];
  for (const c of results || []) {
    const f = await campaignFunding(db, c.id);
    if (f && (f.should_invoice || f.critical)) out.push(f);
  }
  return out.sort((a, b) => b.used_ratio - a.used_ratio);
}

/* ─────────────────────────── writing entries ─────────────────────────── */

export function validateEntry(e) {
  if (!DIRECTIONS.includes(e.direction)) {
    return `'${e.direction}' is not a valid direction. Accepted: ${DIRECTIONS.join(', ')}.`;
  }
  if (!LEDGER_CATEGORIES.includes(e.category)) {
    return `'${e.category}' is not a valid category. Accepted: ${LEDGER_CATEGORIES.join(', ')}.`;
  }
  const amount = Number(e.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    // Direction carries the sign; a negative amount would make sums silently wrong.
    return 'Amount must be a positive number — use the direction to say whether it is money in or out.';
  }
  if (!e.wallet_id) return 'Pick which wallet the money moved from.';
  if (e.transfer_wallet_id && Number(e.transfer_wallet_id) === Number(e.wallet_id)) {
    return 'A transfer needs two different wallets.';
  }
  if (e.transfer_wallet_id && e.direction !== 'out') {
    return 'A transfer is recorded as money OUT of the source wallet.';
  }
  return null;
}

export async function addEntry(db, e) {
  const problem = validateEntry(e);
  if (problem) return { error: problem, status: 400 };

  const now = Date.now();
  const res = await db.prepare(
    `INSERT INTO ledger_entries
       (direction, amount, wallet_id, transfer_wallet_id, category, campaign_id, client_id,
        clipper_id, invoice_id, payment_id, method, reference, note, status, occurred_at,
        created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  ).bind(
    e.direction, Math.round(Number(e.amount)), e.wallet_id, e.transfer_wallet_id || null,
    e.category, e.campaign_id || null, e.client_id || null, e.clipper_id || null,
    e.invoice_id || null, e.payment_id || null, e.method || null, e.reference || null,
    e.note || null, e.occurred_at || now, now, e.created_by || 'admin'
  ).run();

  return { ok: true, id: res.meta.last_row_id };
}

/**
 * Voided, never deleted. A ledger you can silently erase is not a ledger, and
 * the reason a figure changed is usually more useful than the figure.
 */
export async function voidEntry(db, id, reason) {
  const res = await db.prepare(
    `UPDATE ledger_entries
        SET status = 'void',
            note = COALESCE(note, '') || ' [voided: ' || ? || ']'
      WHERE id = ? AND status = 'active'`
  ).bind(reason || 'no reason given', id).run();
  if (!(res.meta && res.meta.changes)) return { error: 'That entry is not active.', status: 409 };
  return { ok: true };
}

export async function listEntries(db, {
  walletId = null, category = null, campaignId = null, clientId = null,
  from = null, to = null, includeVoid = false, limit = 200
} = {}) {
  const where = [];
  const args = [];
  if (!includeVoid) where.push("le.status = 'active'");
  if (walletId != null) { where.push('(le.wallet_id = ? OR le.transfer_wallet_id = ?)'); args.push(walletId, walletId); }
  if (category) { where.push('le.category = ?'); args.push(category); }
  if (campaignId != null) { where.push('le.campaign_id = ?'); args.push(campaignId); }
  if (clientId != null) { where.push('le.client_id = ?'); args.push(clientId); }
  if (from != null) { where.push('le.occurred_at >= ?'); args.push(from); }
  if (to != null) { where.push('le.occurred_at <= ?'); args.push(to); }

  const { results } = await db.prepare(
    `SELECT le.*, w.name AS wallet_name, w.kind AS wallet_kind,
            tw.name AS transfer_wallet_name,
            c.name AS campaign_name,
            cl.company_name AS client_name,
            cp.display_name AS clipper_name
       FROM ledger_entries le
       JOIN wallets w ON w.id = le.wallet_id
       LEFT JOIN wallets tw ON tw.id = le.transfer_wallet_id
       LEFT JOIN campaigns c ON c.id = le.campaign_id
       LEFT JOIN clients cl ON cl.id = le.client_id
       LEFT JOIN clippers cp ON cp.id = le.clipper_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY le.occurred_at DESC, le.id DESC
      LIMIT ?`
  ).bind(...args, limit).all();
  return results || [];
}
