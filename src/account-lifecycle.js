// How a clipper account ends: by the clipper's own choice, because it was made and
// never used, or by an admin. One function does the ending (archiveClipper) so the
// three routes cannot drift apart on what "deleted" means.
//
// "Delete" here archives, it never destroys money history. A clipper can have
// locked, paid-out clips, and those rows must survive. What changes is who can log
// in, what personal details we still hold, and whether the username, email, phone
// and Discord identity are free for someone else to use.
//
// Unused-account clean-up is deliberately timid. It only ever touches an account
// that has never done anything (no connected account, no clip, no payment, no video
// in review or approved, no access request in flight), that nobody has opened in
// 30 days, and that we managed to WARN. An account with no way to be warned is
// listed for an admin, never deleted: silently removing someone we could not reach
// is not a warning.

import { now, disconnectSocialAccount, clipperFinancials } from './db.js';
import { reallocateCampaign } from './earnings.js';
import { sendDirectMessage } from './discord.js';
import { logAction } from './audit.js';
import { logError } from './error-log.js';

const DAY = 24 * 60 * 60 * 1000;
export const DORMANT_AFTER_MS = 30 * DAY;
export const GRACE_MS = 14 * DAY;
// A ceiling per daily run, so a bug in the rules can never wipe the roster in one go.
export const SWEEP_LIMITS = { warn: 25, remove: 25 };
// last_seen_at is written at most this often. Frequent enough for a 30-day rule,
// rare enough not to turn every dashboard request into a database write.
export const SEEN_EVERY_MS = 6 * 60 * 60 * 1000;

const rupees = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/* ------------------------------------------------------------------ ending */

/**
 * Ends an account. Unlinks every social account the way the per-account
 * Disconnect does (pending clips removed, settled ones kept), then marks the
 * clipper 'deleted' and frees the username.
 *
 * `scrub` is for the clipper's own deletion and for unused accounts: it also
 * removes the personal details and the password, and frees the email, phone and
 * Discord username. The payout details (UPI, legal name) are kept only if the
 * account has money history, because a payment record without them cannot be
 * audited. An admin's archive does not scrub: it can be restored.
 */
export async function archiveClipper(env, clipperId, { reason, scrub = false } = {}) {
  const db = env.DB;
  const clipper = await db.prepare('SELECT id, status, username FROM clippers WHERE id = ?').bind(clipperId).first();
  if (!clipper) return { error: 'Not found', status: 404 };
  if (clipper.status === 'deleted') return { ok: true, already: true };

  const { results: accounts } = await db.prepare('SELECT id FROM social_accounts WHERE clipper_id = ?').bind(clipperId).all();
  const touched = new Set();
  for (const a of accounts || []) {
    const r = await disconnectSocialAccount(db, a.id, { preserveClips: true });
    for (const cid of (r ? r.campaigns : [])) touched.add(cid);
  }
  for (const cid of touched) await reallocateCampaign(db, cid);

  const money = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM payments WHERE clipper_id = ?1)
          + (SELECT COUNT(*) FROM submissions WHERE clipper_id = ?1 AND locked_at IS NOT NULL) AS n`
  ).bind(clipperId).first();
  const hasMoney = !!(money && money.n > 0);

  const ts = now();
  // The Discord link is freed with the username: both are UNIQUE, so an archived
  // account would otherwise hold them forever.
  let sql = `UPDATE clippers SET status = 'deleted', username = username || '_deleted' || id,
             discord_user_id = NULL, discord_handle = NULL, discord_linked_at = NULL,
             dormant_warned_at = NULL, dormant_warned_via = NULL,
             deleted_at = ?, deleted_reason = ?`;
  if (scrub) {
    sql += `, email = NULL, contact_number = NULL, discord_username = NULL,
             display_name = 'Deleted clipper', password_hash = 'deleted', password_salt = '00'`;
    if (!hasMoney) sql += ', upi_id = NULL, upi_account_name = NULL, legal_name = NULL';
  }
  await db.prepare(sql + ' WHERE id = ?').bind(ts, reason || 'admin', clipperId).run();
  return { ok: true, freed_username: clipper.username, kept_payout_details: scrub && hasMoney };
}

/**
 * Whether the clipper may delete their own account right now. Money owed to them,
 * or by them, is settled first: deleting must never be a way to lose earnings by
 * accident or to walk away from an advance.
 */
export async function selfDeleteBlockers(db, clipperId) {
  const fin = await clipperFinancials(db, clipperId);
  if (fin.owed > 0 || fin.pending_clips > 0) {
    return {
      blocked: true,
      reason: `You still have ${rupees(fin.owed)} waiting to be paid out${fin.pending_clips ? ` across ${fin.pending_clips} clip${fin.pending_clips === 1 ? '' : 's'}` : ''}. Deleting now would lose it. You can delete your account after your next payout, or ask the ClipGrow team.`
    };
  }
  if (fin.advanced > 0) {
    return { blocked: true, reason: 'You have an advance that has not been fully repaid yet. Contact the ClipGrow team to settle it, then you can delete your account.' };
  }
  return { blocked: false, reason: null };
}

/* ---------------------------------------------------------- unused accounts */

/**
 * Accounts that are unused by the rules above and have not been opened for the
 * inactivity period. Each row says how it stands: never warned, warned and inside
 * the grace period, ready to remove, or unreachable (no warning could be sent).
 */
export async function dormantAccounts(db, at = Date.now()) {
  const { results } = await db.prepare(
    `SELECT c.id, c.username, c.display_name, c.created_at, c.last_seen_at, c.created_by_type,
            c.discord_user_id, c.dormant_warned_at, c.dormant_warned_via
       FROM clippers c
      WHERE c.status = 'active' AND c.dormant_exempt = 0
        AND COALESCE(c.last_seen_at, c.created_at) < ?
        AND NOT EXISTS (SELECT 1 FROM social_accounts s WHERE s.clipper_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.clipper_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.clipper_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM campaign_applications a WHERE a.clipper_id = c.id AND a.status IN ('approved', 'pending'))
        AND NOT EXISTS (SELECT 1 FROM tester_requests t WHERE t.clipper_id = c.id AND t.status IN ('requested', 'invited', 'confirmed'))
      ORDER BY COALESCE(c.last_seen_at, c.created_at) ASC`
  ).bind(at - DORMANT_AFTER_MS).all();

  return (results || []).map(r => {
    const lastActive = r.last_seen_at || r.created_at;
    // A warning only counts if it came AFTER the last time they were seen: one sent
    // before a login says nothing about the inactivity that has run since.
    const warned = !!(r.dormant_warned_at && r.dormant_warned_via && r.dormant_warned_at > lastActive);
    let state;
    if (warned) state = at - r.dormant_warned_at >= GRACE_MS ? 'ready' : 'warned';
    // A linked Discord id is the only way to reach someone today. When email
    // sending exists, it becomes a second way and only this line changes.
    else state = r.discord_user_id ? 'unwarned' : 'unreachable';
    return {
      ...r, last_active: lastActive, state,
      remove_after: warned ? r.dormant_warned_at + GRACE_MS : null
    };
  });
}
export function warningText(row, removeAt) {
  const name = row.display_name || row.username;
  const date = new Date(removeAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  return `Hi ${name}, your ClipGrow account **${row.username}** has not been used for 30 days: no account connected and no video sent.\n\n` +
    `To keep it, just log in at https://clipgrow.in/clipper and start a campaign. If we do not see you by **${date}**, the account will be deleted and the username freed. ` +
    `Nothing is owed to you on it, so you would lose nothing but the account itself.`;
}

/**
 * The daily pass. Warns first; removes only accounts whose warning arrived at least
 * a grace period ago and which are still unused. Capped per run. Never throws for
 * one bad account: it is counted and the pass moves on.
 */
export async function runDormantSweep(env, at = Date.now(), limits = SWEEP_LIMITS) {
  const out = { warned: 0, removed: 0, unreachable: 0, failed: 0 };
  const rows = await dormantAccounts(env.DB, at);
  for (const r of rows) {
    try {
      if (r.state === 'ready') {
        if (out.removed >= limits.remove) continue;
        const res = await archiveClipper(env, r.id, { reason: 'inactive', scrub: true });
        if (res.ok) {
          out.removed++;
          await logAction(env.DB, {
            staffType: 'system', staffName: 'Clean-up', action: 'remove_unused_account',
            targetType: 'clipper', targetId: r.id, targetLabel: r.username,
            detail: `Unused for ${Math.floor((at - r.last_active) / DAY)} days; warned on Discord ${new Date(r.dormant_warned_at).toISOString()}.`
          });
        }
      } else if (r.state === 'unwarned') {
        if (out.warned >= limits.warn) continue;
        const removeAt = at + GRACE_MS;
        const sent = await sendDirectMessage(env, r.discord_user_id, warningText(r, removeAt));
        if (sent.ok) {
          await env.DB.prepare("UPDATE clippers SET dormant_warned_at = ?, dormant_warned_via = 'discord' WHERE id = ?").bind(at, r.id).run();
          out.warned++;
        } else {
          // Not warned means not removed: it stays on the admin's list as unreachable.
          out.unreachable++;
        }
      } else if (r.state === 'unreachable') {
        out.unreachable++;
      }
    } catch (e) {
      out.failed++;
      await logError(env.DB, { actorType: 'system', source: 'cleanup', code: 'DORMANT_SWEEP',
        message: `Could not process unused account ${r.username}`, detail: String(e && e.message), path: 'cron' });
    }
  }
  return out;
}

/** Keeps last_seen_at fresh, and cancels any warning: a returning clipper starts over. */
export async function touchLastSeen(db, clipper, at = now()) {
  if (clipper.last_seen_at && at - clipper.last_seen_at < SEEN_EVERY_MS) return;
  await db.prepare('UPDATE clippers SET last_seen_at = ?, dormant_warned_at = NULL, dormant_warned_via = NULL WHERE id = ?')
    .bind(at, clipper.id).run();
}
