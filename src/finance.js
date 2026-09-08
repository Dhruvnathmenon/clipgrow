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

// Clippers and clients always see the FULL campaign budget and its limits. This
// wallet split is internal bookkeeping only -- it never changes a public number.

export const LEDGER_CATEGORIES = [
  'client_payment',     // in  — the clipper share of a client payment
  'clipper_payout',     // out — money reaching a clipper
  'management_fee',     // in  — ClipGrow's share of a client payment
  // in — the gap between what a clip was billed and the CPM-multiple floor
  // actually paid to the clipper, realized at settlement (src/payouts.js's
  // settlePayment). Deliberately NOT profit taken to pocket -- lands in the
  // same wallet clipper payouts draw from, held in reserve for clipper
  // bonuses or campaign promotion spend. See src/earnings.js's
  // allocateCampaignEarnings for how clipper_earning is derived.
  'view_margin',
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
    `SELECT w.id, w.name, w.kind, w.status,
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

  // One payment splitting into two entries used to mean two separate writes
  // -- a crash between them left a payment half-recorded (the clipper share
  // landed, the fee share never did, permanently). Built and run together
  // in one batch now, so either both land or neither does.
  const built = [
    buildEntryStatement(db, {
      ...common, direction: 'in', amount: poolShare, wallet_id: agency.id,
      category: 'client_payment',
      note: note ? `${note} — clipper share` : 'Client payment — clipper share'
    })
  ];
  if (fee > 0) {
    built.push(buildEntryStatement(db, {
      ...common, direction: 'in', amount: fee, wallet_id: clipgrow.id,
      category: 'management_fee',
      note: note ? `${note} — ${feePercent}% fee` : `Management fee (${feePercent}%)`
    }));
  }
  const failed = built.find(b => b.error);
  if (failed) return failed;

  const results = await db.batch(built.map(b => b.statement));
  const [poolEntryId, feeEntryId] = results.map(r => r.meta.last_row_id);

  return { ok: true, total, pool_share: poolShare, fee, pool_entry: poolEntryId, fee_entry: feeEntryId || null };
}

/**
 * Tops up a campaign's clipper-payable budget.
 *
 * Deliberately NOT the same shape as recordClientPayment above. That
 * function takes a total client payment and carves the fee OUT of it
 * (poolShare = total - fee), matching how a fresh client payment against an
 * existing budget is recorded. A top-up is the opposite direction: the
 * admin decides how much MORE spending power the campaign needs -- the
 * same round number a campaign's initial budget already is at creation
 * time (`POST /api/admin/campaigns` takes `budget` directly, no fee split)
 * -- and the 20% fee is an ADDITIONAL amount charged on top of that, not a
 * slice taken from it. `campaigns.budget` increases by exactly `amount`,
 * the same literal value used for the ledger's pool-share entry -- one
 * variable, not two independently-derived ones, so they can never drift.
 */
export async function topUpCampaignBudget(db, {
  campaignId, amount, feePercent = 20,
  method = null, reference = null, note = null, occurredAt = null, createdBy = 'admin'
}) {
  if (!campaignId) return { error: 'A campaign is required.', status: 400 };
  const campaign = await db.prepare('SELECT id FROM campaigns WHERE id = ?').bind(campaignId).first();
  if (!campaign) return { error: 'Campaign not found.', status: 404 };

  const budgetIncrease = Math.round(Number(amount));
  if (!Number.isFinite(budgetIncrease) || budgetIncrease <= 0) {
    return { error: 'Amount must be a positive number.', status: 400 };
  }
  const agency = await walletOfKind(db, 'agency');
  const clipgrow = await walletOfKind(db, 'clipgrow');
  if (!agency || !clipgrow) return { error: 'Wallets are not set up.', status: 500 };

  // An extra 20% ON TOP of the budget increase, not carved out of it.
  const fee = Math.round((budgetIncrease * feePercent) / 100);
  const total = budgetIncrease + fee;
  const at = occurredAt || Date.now();
  const common = { campaign_id: campaignId, method, reference, occurred_at: at, created_by: createdBy };

  const built = [
    buildEntryStatement(db, {
      ...common, direction: 'in', amount: budgetIncrease, wallet_id: agency.id,
      category: 'client_payment',
      note: note ? `${note} — budget top-up` : 'Budget top-up — clipper share'
    })
  ];
  if (fee > 0) {
    built.push(buildEntryStatement(db, {
      ...common, direction: 'in', amount: fee, wallet_id: clipgrow.id,
      category: 'management_fee',
      note: note ? `${note} — ${feePercent}% fee` : `Management fee on top-up (${feePercent}%)`
    }));
  }
  const failed = built.find(b => b.error);
  if (failed) return failed;

  // Same budgetIncrease variable feeds both this UPDATE and the ledger
  // entry above -- see the doc comment.
  const statements = [
    ...built.map(b => b.statement),
    db.prepare('UPDATE campaigns SET budget = budget + ? WHERE id = ?').bind(budgetIncrease, campaignId)
  ];
  const results = await db.batch(statements);
  const [poolEntryId, feeEntryId] = results.map(r => r.meta.last_row_id);

  return {
    ok: true, budget_increase: budgetIncrease, fee, total,
    pool_share: budgetIncrease, // kept for API-shape compatibility with recordClientPayment's response
    pool_entry: poolEntryId, fee_entry: fee > 0 ? feeEntryId : null
  };
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
                                clientId = null, from = null, to = null, walletKind = null } = {}) {
  const where = ["le.status = 'active'"];
  const args = [];
  if (direction) { where.push('le.direction = ?'); args.push(direction); }
  if (categories && categories.length) {
    where.push(`le.category IN (${categories.map(() => '?').join(',')})`);
    args.push(...categories);
  }
  if (campaignId != null) { where.push('le.campaign_id = ?'); args.push(campaignId); }
  if (clientId != null) { where.push('le.client_id = ?'); args.push(clientId); }
  if (from != null) { where.push('le.occurred_at >= ?'); args.push(from); }
  if (to != null) { where.push('le.occurred_at <= ?'); args.push(to); }
  // Which pot the money actually left from -- lets a refund be told apart as
  // "against the clipper budget pool" vs "against the fee we'd already
  // taken", the same way client_payment/management_fee are already told
  // apart by which wallet receives them.
  if (walletKind) { where.push('w.kind = ?'); args.push(walletKind); }

  const row = await db.prepare(
    `SELECT COALESCE(SUM(le.amount), 0) AS total FROM ledger_entries le
       JOIN wallets w ON w.id = le.wallet_id
      WHERE ${where.join(' AND ')}`
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
    'SELECT id, name, budget, fee_percent, campaign_kind, status FROM campaigns WHERE id = ?'
  ).bind(campaignId).first();
  if (!campaign) return null;

  const internal = campaign.campaign_kind === 'internal';
  const delivered = await campaignSpend(db, campaignId);
  const feePercent = internal ? 0 : Number(campaign.fee_percent || 0);

  // Delivered splits into money that has actually reached a clipper (locked
  // to a payment) and money a clipper has earned but not been paid yet.
  // Together these always equal `delivered` -- the same guarantee
  // spendExpr/SPEND_EXPR gives, just broken into the two halves a founder
  // actually asks for: "settled" and "left to settle".
  const settleRow = await db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN locked_at IS NOT NULL THEN COALESCE(locked_earning,0) ELSE 0 END), 0) AS settled,
       COALESCE(SUM(CASE WHEN locked_at IS NULL AND status = 'active' THEN earning ELSE 0 END), 0) AS pending
     FROM submissions WHERE campaign_id = ?`
  ).bind(campaignId).first();
  const settled = (settleRow && settleRow.settled) || 0;
  const pending = (settleRow && settleRow.pending) || 0;

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
  // Split by which wallet the refund actually left from -- a refund against
  // the leftover budget pool and a refund against fee already taken are two
  // different physical movements, told apart the same way client_payment
  // and management_fee are already told apart by which wallet receives them.
  // Without this split, a real refund never reduced what the campaign
  // showed as still owed: the campaign would say "owes ₹4,000" forever,
  // even the day after that exact ₹4,000 was actually refunded.
  const refundedFromBudget = internal ? 0 : await sumEntries(db, {
    direction: 'out', categories: ['refund'], campaignId, walletKind: 'agency'
  });
  const refundedFromFee = internal ? 0 : await sumEntries(db, {
    direction: 'out', categories: ['refund'], campaignId, walletKind: 'clipgrow'
  });
  const refunded = refundedFromBudget + refundedFromFee;

  const clientPaid = poolReceived + feeTaken - refunded;

  // The refund, decomposed the way the money physically has to move:
  //   whatever is left of the clipper pool for this campaign, minus any of
  //   it already sent back,
  //   PLUS fee we took on receipt but never earned by delivering, minus any
  //   of THAT already sent back.
  // The second half is why taking the fee up front has a cost -- it has to
  // come back out of the agency wallet, not the pool.
  // Signed, unfloored versions of the same two numbers -- positive means a
  // refund is owed to the client, negative means the client still owes for
  // work already delivered. This is the one place that math happens; admin.html's
  // Per Campaign table reads these two fields directly instead of
  // recomputing them from pool_received/delivered/fee_taken/fee_earned, so
  // there is exactly one definition of this balance, not two that can drift
  // (see accountIssues() in db.js for the exact same lesson learned once
  // already this project).
  const budgetBalance = internal ? 0 : poolReceived - delivered - refundedFromBudget;
  const feeBalance = internal ? 0 : feeTaken - feeEarned - refundedFromFee;
  const unspentPool = Math.max(0, budgetBalance);
  const unearnedFee = Math.max(0, feeBalance);
  const refundDue = internal ? 0 : unspentPool + unearnedFee;

  // The fee side's own two headline numbers, mirroring budget/delivered:
  //   agencyFeeBudget  the fee ceiling if the whole budget gets delivered.
  //   feeUncollected   fee already earned by real results that the client
  //                     has not paid yet -- the mirror image of unearnedFee
  //                     (fee paid but not yet earned).
  const agencyFeeBudget = internal ? 0 : Math.round((campaign.budget || 0) * feePercent / 100);
  const feeUncollected = internal ? 0 : Math.max(0, feeEarned - feeTaken);

  // Owed to us: delivered work the client has not covered.
  const shortfall = internal ? 0 : Math.max(0, obligation - clientPaid);

  return {
    campaign_id: campaign.id,
    name: campaign.name,
    is_internal: internal,
    budget: campaign.budget || 0,
    delivered,
    settled,
    pending,
    fee_percent: feePercent,
    fee_earned: feeEarned,
    fee_taken: feeTaken,
    unearned_fee: unearnedFee,
    agency_fee_budget: agencyFeeBudget,
    fee_uncollected: feeUncollected,
    pool_received: poolReceived,
    unspent_pool: unspentPool,
    budget_balance: budgetBalance,
    fee_balance: feeBalance,
    // An internal campaign is ClipGrow's own marketing: nobody bills for it, so
    // the money paid to clippers is a straight cost rather than pass-through.
    cost: internal ? delivered : 0,
    client_obligation: obligation,
    client_paid: clientPaid,
    balance: internal ? 0 : clientPaid - obligation,
    refund_due: refundDue,
    shortfall,
    status: campaign.status
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
  // Unlike the management fee, margin has no separate accrual figure -- it
  // only ever comes into existence the instant a settlement realizes it
  // (src/payouts.js's settlePayment), so "captured" and "earned" are the
  // same number by construction; nothing to double-report.
  const viewMarginCaptured = await sumEntries(db, { direction: 'in', categories: ['view_margin'], from, to });
  const directCosts = await sumEntries(db, { direction: 'out', categories: COST_CATEGORIES, from, to });
  // The specific pair "what did clients actually send us" vs "what actually
  // reached a clipper" -- narrower than money_in/money_out below, which also
  // include fees, tools, ads, refunds and capital movements.
  const clientPaymentsReceived = await sumEntries(db, { direction: 'in', categories: ['client_payment'], from, to });
  const clipperPayoutsPaid = await sumEntries(db, { direction: 'out', categories: ['clipper_payout'], from, to });

  const wallets = await walletBalances(db);
  const agencyBalance = wallets.filter(w => w.kind === 'agency').reduce((n, w) => n + w.balance, 0);
  const clipgrowBalance = wallets.filter(w => w.kind === 'clipgrow').reduce((n, w) => n + w.balance, 0);

  const moneyIn = await sumEntries(db, { direction: 'in', from, to });
  const moneyOut = await sumEntries(db, { direction: 'out', from, to });
  const costs = directCosts + internalCost;

  return {
    fees_earned: feesEarned,
    fees_collected: feesCollected,
    // Explicitly NOT profit -- confirmed reserved for clipper bonuses and
    // campaign promotion spend, not taken to pocket. Reported alongside the
    // fee figures because it's the same "second revenue stream" question a
    // founder is asking when they look at this panel, even though it isn't
    // counted in `profit` below.
    view_margin_captured: viewMarginCaptured,
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
    // The clipper-pool half of what clients paid, vs what clippers were
    // actually sent -- the two numbers a founder means by "cash in vs out".
    client_payments_received: clientPaymentsReceived,
    clipper_payouts_paid: clipperPayoutsPaid,

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

/**
 * Validates and PREPARES (but does not run) the INSERT for one ledger
 * entry. Exists so a caller that needs this write to be genuinely atomic
 * with other writes -- settlePayment() recording a payout alongside the
 * submission locks it settles -- can push the returned statement into
 * their own db.batch() instead of it running on its own, separately,
 * un-coordinated with the rest of that operation. addEntry() below is just
 * this plus .run() for every caller that doesn't need that.
 */
export function buildEntryStatement(db, e) {
  const problem = validateEntry(e);
  if (problem) return { error: problem, status: 400 };

  const now = Date.now();
  const statement = db.prepare(
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
  );
  return { statement };
}

export async function addEntry(db, e) {
  const built = buildEntryStatement(db, e);
  if (built.error) return built;
  const res = await built.statement.run();
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
