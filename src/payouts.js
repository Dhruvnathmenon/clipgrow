import { now, maxPayoutPerVideo } from './db.js';
import { clipState, clipStateMessage, daysSince } from './clipstate.js';
import { platformLabel } from './platforms.js';
import { reallocateCampaign } from './earnings.js';

// Settling a payout.
//
// The rule that makes the whole system safe: paying for a clip LOCKS it.
// `locked_earning` is the amount that was actually settled, and the allocator
// treats it as history from then on -- it is never re-priced, it always
// consumes budget, and it survives any later change to the clip, the CPM, the
// threshold or the budget. A locked clip cannot be locked twice, which is also
// what makes a double-clicked Pay button harmless.

const DAY_MS = 24 * 60 * 60 * 1000;

// A clip that never reached the campaign minimum is closed the moment it is
// looked at during a payout run -- not after some fixed grace period. The
// grace period a clip effectively gets is however wide the admin's own payout
// window is (they choose that cadence: weekly, monthly, whatever), so there
// is no separate age threshold to track here. See settlePayment's write-off
// path and writeOffAllBelowMin below.

function clipAgeDays(row) {
  return daysSince(row.posted_at || row.created_at);
}

/**
 * Every clip for one clipper inside a window, with everything needed to decide
 * what to pay for. `days = 0` means no window (all time).
 */
export async function payableClips(db, clipperId, { days = 30, campaignId = null } = {}) {
  const since = days > 0 ? Date.now() - days * DAY_MS : 0;

  const { results } = await db.prepare(
    `SELECT s.id, s.permalink, s.views, s.earning, s.status, s.sync_error, s.source,
            s.platform, s.duration_seconds, s.is_short, s.eligible,
            s.created_at, s.posted_at, s.last_synced_at, s.last_ok_sync_at,
            s.locked_at, s.locked_earning, s.lock_reason, s.payment_id,
            c.id AS campaign_id, c.name AS campaign_name, c.cpm, c.min_views, c.blueprint_json,
            a.username AS account_username,
            pay.reference AS payment_reference, pay.paid_at AS payment_paid_at
     FROM submissions s
     JOIN campaigns c ON c.id = s.campaign_id
     LEFT JOIN social_accounts a ON a.id = s.account_id
     LEFT JOIN payments pay ON pay.id = s.payment_id
     WHERE s.clipper_id = ?
       AND COALESCE(s.posted_at, s.created_at) >= ?
       ${campaignId ? 'AND s.campaign_id = ?' : ''}
     ORDER BY COALESCE(s.posted_at, s.created_at) DESC`
  ).bind(...(campaignId ? [clipperId, since, campaignId] : [clipperId, since])).all();

  const clips = (results || []).map(r => {
    const state = clipState(r);
    const maxPerVideo = maxPayoutPerVideo(r);
    const uncapped = r.views >= (r.min_views || 0)
      ? Math.floor((r.views / 1000) * (r.cpm || 0))
      : 0;
    const ageDays = clipAgeDays(r);
    // Mirrors clipState's own 'below_min' gate exactly (src/clipstate.js) --
    // a clip only counts as "under the minimum" once it has actually been
    // checked at least once and is otherwise a normal, earning-eligible clip.
    // Without the eligible/status/last_ok_sync_at gates, a brand new clip
    // that has never been synced (views defaults to 0) would look identical
    // to one that was checked and genuinely fell short, which would have made
    // it eligible for write-off before it ever got a real look.
    const belowMin = !r.locked_at && r.status === 'active' && r.eligible !== 0 &&
      !!r.last_ok_sync_at && (r.min_views || 0) > 0 && r.views < r.min_views;

    return {
      id: r.id,
      campaign_id: r.campaign_id,
      campaign_name: r.campaign_name,
      permalink: r.permalink,
      account_username: r.account_username,
      platform: r.platform || 'instagram',
      platform_label: platformLabel(r.platform || 'instagram'),
      is_short: r.is_short == null ? null : !!r.is_short,
      eligible: r.eligible !== 0,
      source: r.source || 'manual',
      views: r.views,
      cpm: r.cpm,
      min_views: r.min_views || 0,
      views_needed: Math.max(0, (r.min_views || 0) - r.views),
      earning: r.earning,
      uncapped_earning: uncapped,
      max_per_video: maxPerVideo,
      // True only when the per-video ceiling is the actual reason the number is
      // lower than raw views x CPM. A clip that earns nothing because it is
      // ineligible was not "capped", and saying so would send the admin
      // hunting for a pricing bug that does not exist.
      capped: r.eligible !== 0 && maxPerVideo > 0 && uncapped > maxPerVideo,
      state,
      state_message: clipStateMessage(state, r),
      below_min: belowMin,
      age_days: ageDays,
      // Any clip still under the minimum is due for write-off the moment a
      // payout is run over it -- the payout window itself is the grace
      // period, so there is no extra age threshold on top of it.
      write_off_due: belowMin,
      posted_at: r.posted_at,
      synced_at: r.created_at,
      last_ok_sync_at: r.last_ok_sync_at,
      locked_at: r.locked_at,
      locked_earning: r.locked_earning,
      lock_reason: r.lock_reason,
      payment_id: r.payment_id,
      payment_reference: r.payment_reference,
      payment_paid_at: r.payment_paid_at,
      // Only unlocked clips can be settled now.
      selectable: !r.locked_at && r.status === 'active' && r.earning > 0,
      locked: !!r.locked_at
    };
  });

  const totals = {
    clips: clips.length,
    payable_now: clips.filter(c => c.selectable).reduce((n, c) => n + c.earning, 0),
    payable_clips: clips.filter(c => c.selectable).length,
    already_settled: clips.filter(c => c.locked).reduce((n, c) => n + (c.locked_earning || 0), 0),
    settled_clips: clips.filter(c => c.locked).length,
    write_off_clips: clips.filter(c => c.write_off_due).length,
    below_min_clips: clips.filter(c => c.below_min).length,
    ineligible_clips: clips.filter(c => !c.eligible).length,
    views: clips.reduce((n, c) => n + (c.views || 0), 0)
  };

  // Both platforms draw on one budget, but the split is worth seeing at a
  // glance when deciding a payout.
  const byPlatform = {};
  for (const c of clips) {
    const p = c.platform;
    if (!byPlatform[p]) byPlatform[p] = { platform: p, label: c.platform_label, clips: 0, views: 0, payable: 0, settled: 0 };
    byPlatform[p].clips++;
    byPlatform[p].views += c.views || 0;
    if (c.selectable) byPlatform[p].payable += c.earning;
    if (c.locked) byPlatform[p].settled += c.locked_earning || 0;
  }

  return { clips, totals, by_platform: Object.values(byPlatform) };
}

/**
 * Settles a payout: records the payment and locks every clip it covers.
 *
 * `writeOffIds` are clips being closed at zero (never reached the campaign
 * minimum). They are locked in the same transaction so they stop appearing as
 * pending forever, but they carry no money and are not attached to the payment.
 *
 * Refuses the whole run if any clip is already locked, belongs to someone else,
 * or is listed in both sets -- a partial settlement is far worse than a
 * rejected one, and this is what makes a double-submitted Pay harmless.
 */
export async function settlePayment(db, {
  clipperId, submissionIds = [], writeOffIds = [], amount,
  campaignId = null, method = 'UPI', reference = '', note = '', paidAt = null
}) {
  const payIds = [...new Set(submissionIds.map(Number).filter(Boolean))];
  const offIds = [...new Set(writeOffIds.map(Number).filter(Boolean))];

  const overlap = payIds.filter(id => offIds.includes(id));
  if (overlap.length) {
    return { error: `Clip ${overlap[0]} is listed both as paid and as written off.`, status: 400 };
  }
  if (!payIds.length && !offIds.length) {
    return { error: 'Select at least one clip to settle.', status: 400 };
  }

  const allIds = [...payIds, ...offIds];
  const placeholders = allIds.map(() => '?').join(',');
  const { results: rows } = await db.prepare(
    `SELECT id, clipper_id, campaign_id, earning, status, locked_at
     FROM submissions WHERE id IN (${placeholders})`
  ).bind(...allIds).all();

  const found = new Map((rows || []).map(r => [r.id, r]));

  const missing = allIds.filter(id => !found.has(id));
  if (missing.length) return { error: `Clip ${missing[0]} no longer exists.`, status: 404 };

  const foreign = (rows || []).filter(r => r.clipper_id !== Number(clipperId));
  if (foreign.length) {
    return { error: `Clip ${foreign[0].id} belongs to a different clipper.`, status: 400 };
  }

  const alreadyLocked = (rows || []).filter(r => r.locked_at);
  if (alreadyLocked.length) {
    return {
      error: `${alreadyLocked.length} of these clips are already settled and locked. Nothing was charged again — reload the page to see the current state.`,
      status: 409,
      locked_ids: alreadyLocked.map(r => r.id)
    };
  }

  // The amount owed, computed from the clips themselves rather than trusted
  // from the client, so the locked total always matches what was really earned.
  const clipsTotal = payIds.reduce((n, id) => n + (found.get(id).earning || 0), 0);
  const amt = Math.round(Number(amount));
  if (!Number.isFinite(amt) || amt < 0) return { error: 'Amount must be a number.', status: 400 };
  if (payIds.length && amt <= 0) {
    return { error: 'Amount must be greater than 0 when paying for clips.', status: 400 };
  }

  const ts = paidAt ? Number(paidAt) : now();
  let paymentId = null;

  if (payIds.length) {
    const res = await db.prepare(
      `INSERT INTO payments (clipper_id, campaign_id, amount, method, reference, note, paid_at, created_at, clip_count, clips_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(clipperId, campaignId || null, amt, method || 'UPI', reference || '', note || '',
           ts, now(), payIds.length, clipsTotal).run();
    paymentId = res.meta.last_row_id;
  }

  const stmts = [];
  for (const id of payIds) {
    const row = found.get(id);
    stmts.push(db.prepare(
      `UPDATE submissions SET locked_at = ?, locked_earning = ?, lock_reason = 'paid', payment_id = ?
       WHERE id = ? AND locked_at IS NULL`
    ).bind(ts, row.earning || 0, paymentId, id));
  }
  for (const id of offIds) {
    stmts.push(db.prepare(
      `UPDATE submissions SET locked_at = ?, locked_earning = 0, lock_reason = 'below_min', earning = 0
       WHERE id = ? AND locked_at IS NULL`
    ).bind(ts, id));
  }
  if (stmts.length) await db.batch(stmts);

  // Locked amounts are now fixed, so every affected campaign's remaining
  // budget has to be re-spread across whatever is still open.
  const campaigns = [...new Set((rows || []).map(r => r.campaign_id))];
  for (const cid of campaigns) await reallocateCampaign(db, cid);

  return {
    ok: true,
    payment_id: paymentId,
    paid_clips: payIds.length,
    written_off_clips: offIds.length,
    clips_total: clipsTotal,
    amount: amt,
    // Surfaced so the admin can see at a glance when what they actually
    // transferred differs from what the clips added up to.
    variance: amt - clipsTotal
  };
}

/**
 * Undoes a settlement: removes the payment and unlocks every clip it locked,
 * so they return to the pending pool and re-price on the next allocation.
 * The escape hatch for a mistyped amount or a wrong selection.
 */
export async function reversePayment(db, paymentId) {
  const pay = await db.prepare('SELECT * FROM payments WHERE id = ?').bind(paymentId).first();
  if (!pay) return { error: 'Payment not found.', status: 404 };

  const { results: subs } = await db.prepare(
    'SELECT id, campaign_id FROM submissions WHERE payment_id = ?'
  ).bind(paymentId).all();

  await db.batch([
    db.prepare(
      `UPDATE submissions SET locked_at = NULL, locked_earning = NULL, lock_reason = NULL, payment_id = NULL
       WHERE payment_id = ?`
    ).bind(paymentId),
    db.prepare('DELETE FROM payments WHERE id = ?').bind(paymentId)
  ]);

  const campaigns = [...new Set((subs || []).map(r => r.campaign_id))];
  for (const cid of campaigns) await reallocateCampaign(db, cid);

  return { ok: true, unlocked_clips: (subs || []).length };
}

/**
 * Closes out every currently below-minimum, unlocked clip at zero, across as
 * many clips as the (optional) campaign/clipper filters match. This is the
 * "old ones" sweep: clips that fell short before the per-payout write-off
 * existed, or that simply never came up in anyone's payout window. It is
 * money-neutral by construction -- every clip it touches already had
 * `earning = 0` (below the minimum never earns), so nothing owed to anyone
 * changes. Locking with `lock_reason = 'below_min'` still leaves the normal
 * escape hatch: an admin can reopen any of these individually from the
 * Payouts tab, same as a write-off made through settlePayment.
 *
 * Uses the exact same gate as payableClips' `belowMin` (see above) so this
 * can never sweep up a clip that simply hasn't been synced yet.
 */
export async function writeOffAllBelowMin(db, { campaignId = null, clipperId = null } = {}) {
  const conds = [
    's.locked_at IS NULL',
    "s.status = 'active'",
    's.eligible != 0',
    's.last_ok_sync_at IS NOT NULL',
    'c.min_views > 0',
    's.views < c.min_views'
  ];
  const args = [];
  if (campaignId) { conds.push('s.campaign_id = ?'); args.push(campaignId); }
  if (clipperId) { conds.push('s.clipper_id = ?'); args.push(clipperId); }

  const { results } = await db.prepare(
    `SELECT s.id, s.campaign_id FROM submissions s
     JOIN campaigns c ON c.id = s.campaign_id
     WHERE ${conds.join(' AND ')}`
  ).bind(...args).all();

  const rows = results || [];
  if (!rows.length) return { closed: 0, campaigns: [] };

  const ts = now();
  await db.batch(rows.map(r => db.prepare(
    `UPDATE submissions SET locked_at = ?, locked_earning = 0, lock_reason = 'below_min', earning = 0
     WHERE id = ? AND locked_at IS NULL`
  ).bind(ts, r.id)));

  // Closing these frees up nothing budget-wise (they were earning 0 already),
  // but reallocating keeps every affected campaign's own bookkeeping in sync
  // with the fact that these clips are now permanently out of the pool.
  const campaigns = [...new Set(rows.map(r => r.campaign_id))];
  for (const cid of campaigns) await reallocateCampaign(db, cid);

  return { closed: rows.length, campaigns };
}
