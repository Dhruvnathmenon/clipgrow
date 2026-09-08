import { cpmEarning } from './earning-math.js';
import { maxPayoutPerVideo } from './db.js';
import { getAdapter, campaignPlatforms } from './platforms.js';
import { makeCallCounter, getBudget, MAX_CLIPS_FOR_FULL_REFRESH, CLIP_COOLDOWN_MS } from './rate-budget.js';
import { logAction } from './audit.js';

export async function markAccount(db, accountId, { status, code }) {
  await db.prepare(
    'UPDATE social_accounts SET status = ?, last_error_code = ?, last_error_at = ? WHERE id = ?'
  ).bind(status, code || null, code ? Date.now() : null, accountId).run();
}

async function saveRefreshedToken(db, accountId, fresh) {
  await db.prepare(
    `UPDATE social_accounts
       SET access_token = ?, refresh_token = COALESCE(?, refresh_token),
           token_expires_at = ?, last_error_code = NULL, status = 'connected'
     WHERE id = ?`
  ).bind(fresh.access_token, fresh.refresh_token || null, fresh.expires_at || null, accountId).run();
}

/**
 * Runs a call with a valid token for this account, renewing and persisting it
 * first if the platform needs that. Keeps token mechanics out of every call
 * site, and means a mid-sync expiry never surfaces as a broken clip.
 */
export function withAccount(db, env, account, fn) {
  const adapter = getAdapter(account.platform);
  return adapter.withFreshToken(
    account,
    env,
    (token) => fn({ ...account, access_token: token }),
    async (fresh) => { await saveRefreshedToken(db, account.id, fresh); }
  );
}


/**
 * Fetches views for one account's clips and writes the results.
 *
 * Batching is what makes YouTube affordable: videos.list returns up to 50 ids
 * for one quota unit, where Instagram costs one call per clip. Both go through
 * the same adapter interface, so this code does not care which is which.
 *
 * Each clip's outcome is independent (`{ok:true, views}` / `{ok:false, code}`
 * / absent-from-map = genuinely gone). The adapter is responsible for never
 * letting one clip's failure erase another clip's result -- see the isolation
 * comments in src/platforms.js and src/youtube.js. The outer try/catch here
 * only fires for failures that happen BEFORE any clip could be attempted at
 * all (e.g. a token refresh failing), where "every clip on this account
 * failed identically" is actually true rather than an artifact of one bad
 * item taking the rest down with it.
 */
/**
 * Which of an Instagram account's clips may actually be attempted right now,
 * respecting both the per-clip 1-hour cooldown and the account's real,
 * rolling-window rate budget. Shared by the plain sync path and the
 * streaming per-clip refresh, so there is exactly one place this policy is
 * decided rather than two that could quietly drift apart.
 */
export async function planInstagramSync(db, accountId, subs, { skipCooldown = false } = {}) {
  // The per-clip cooldown exists to stop an AUTOMATIC sweep (cron, "full
  // refresh") from wastefully re-checking clips it only just checked minutes
  // ago. It was never meant to stop a clipper from deliberately spending one
  // of their own calls on a specific clip right now -- that's their budget to
  // spend, and the account-level check below is what actually protects it.
  // `skipCooldown` is how the single-clip refresh route opts out of it.
  const eligible = skipCooldown
    ? subs
    : subs.filter(s => !s.last_ok_sync_at || (Date.now() - s.last_ok_sync_at) >= CLIP_COOLDOWN_MS);

  if (eligible.length > MAX_CLIPS_FOR_FULL_REFRESH) {
    // Hard refusal, not a partial or priority-ordered attempt: even a
    // completely fresh hour of budget cannot cover this account in one pass,
    // so nothing is attempted rather than silently doing part of the job.
    // The account needs clips locked/paid down below the line, not a
    // cleverer sync order.
    return { attempt: [], blocked: 'TOO_MANY_ACTIVE_CLIPS', eligible: eligible.length, deferred: subs.length, budget: null };
  }

  const budget = await getBudget(db, accountId);
  const attempt = eligible.slice(0, budget.remaining);
  return {
    attempt,
    blocked: attempt.length === 0 && eligible.length > 0 ? 'BUDGET_EXHAUSTED' : null,
    eligible: eligible.length,
    deferred: subs.length - attempt.length,
    budget
  };
}

/*
 * Every write below carries "AND locked_at IS NULL". A settled clip is
 * financial history: its earning is frozen at locked_earning and the books say
 * that is what was owed. Without the guard a clip paid mid-sync -- between the
 * read that built this work list and the write that lands -- still had its
 * views and last_ok_sync_at moved afterwards, which desynchronised the CSV
 * audit trail that prints views alongside locked_earning. refresh-jobs.js has
 * always guarded its writes this way; this path had not been brought in line.
 */
export async function syncAccountClips(db, env, account, subs, { skipCooldown = false } = {}) {
  if (!account.access_token || account.status === 'revoked') {
    for (const s of subs) {
      await db.prepare('UPDATE submissions SET sync_error = ? WHERE id = ? AND locked_at IS NULL').bind('NO_ACCOUNT', s.id).run();
    }
    return { synced: 0, failed: subs.length };
  }

  const adapter = getAdapter(account.platform);
  const isInstagram = account.platform === 'instagram';

  // Instagram's 200-calls/hour limit is real, per-account, and NOT reduced by
  // batching (Meta counts every call in a batch individually -- see
  // src/rate-budget.js). This is the one place both the 6-hourly cron and
  // every manual refresh path funnel through, so gating it here protects all
  // of them at once rather than needing the same logic duplicated per caller.
  let attemptSubs = subs;
  let counter = null;
  let blocked = null;
  let deferred = 0;

  if (isInstagram) {
    const plan = await planInstagramSync(db, account.id, subs, { skipCooldown });
    attemptSubs = plan.attempt;
    blocked = plan.blocked;
    deferred = plan.deferred;
    if (plan.blocked === 'TOO_MANY_ACTIVE_CLIPS') {
      return { synced: 0, failed: 0, blocked: plan.blocked, eligible: plan.eligible, deferred: plan.deferred };
    }
    if (attemptSubs.length === 0) {
      return { synced: 0, failed: 0, blocked, deferred };
    }
    counter = makeCallCounter(account.id);
  }

  const ids = attemptSubs.map(s => s.ig_media_id);
  let results;
  try {
    results = await withAccount(db, env, account,
      (acct) => adapter.fetchViews(acct, ids, env, counter ? { onAttempt: counter.onAttempt } : {}));
  } catch (e) {
    // Nothing could even be attempted -- genuinely affects every clip equally.
    const code = (e && e.code) || 'UNKNOWN';
    for (const s of attemptSubs) {
      await db.prepare('UPDATE submissions SET sync_error = ?, last_synced_at = ? WHERE id = ? AND locked_at IS NULL')
        .bind(code, Date.now(), s.id).run();
    }
    if (e && e.needsReauth) await markAccount(db, account.id, { status: 'needs_reauth', code });
    if (counter) await counter.flush(db);
    return { synced: 0, failed: attemptSubs.length, deferred };
  }
  if (counter) await counter.flush(db);

  const now = Date.now();
  let needsReauthCode = null;
  let synced = 0, failed = 0;
  for (const s of attemptSubs) {
    const r = results.get(s.ig_media_id);

    if (r == null) {
      // Genuinely absent from a successful response: the honest signal that
      // the post has been deleted or made private, not a fetch failure.
      await db.prepare('UPDATE submissions SET sync_error = ?, last_synced_at = ? WHERE id = ? AND locked_at IS NULL')
        .bind('MEDIA_NOT_FOUND', now, s.id).run();
      failed++;
      continue;
    }

    if (!r.ok) {
      // This clip's own fetch failed. Recorded against this clip alone --
      // every other clip on the same account keeps updating normally this
      // round, which is the entire point of this shape.
      await db.prepare('UPDATE submissions SET sync_error = ?, last_synced_at = ? WHERE id = ? AND locked_at IS NULL')
        .bind(r.code, now, s.id).run();
      if (r.needsReauth) needsReauthCode = r.code;
      failed++;
      continue;
    }

    await db.prepare(
      'UPDATE submissions SET views = ?, last_synced_at = ?, last_ok_sync_at = ?, sync_error = NULL WHERE id = ? AND locked_at IS NULL'
    ).bind(r.views, now, now, s.id).run();
    synced++;
  }

  if (needsReauthCode) await markAccount(db, account.id, { status: 'needs_reauth', code: needsReauthCode });
  else if (synced > 0 && account.status !== 'connected') {
    await markAccount(db, account.id, { status: 'connected', code: null });
  }
  return { synced, failed, blocked, deferred };
}

/**
 * The live-progress version of an Instagram account refresh: fetches one
 * clip at a time and yields a result immediately after each one completes,
 * instead of resolving once at the end. Backs the SSE refresh endpoint so a
 * clipper watching a 150-clip refresh sees real numbers land one by one with
 * an accurate progress count, not a blank spinner for however long the whole
 * batch takes.
 *
 * Shares planInstagramSync with the plain (non-streaming) path, so the same
 * cooldown and budget rules apply identically either way -- there is exactly
 * one decision of "what may be attempted right now," just two ways of
 * running it.
 *
 * Yields: {type:'blocked', reason, eligible} once, or
 *         {type:'progress', done, total, clip_id, ok, views?, code?} per clip, or
 *         {type:'done', synced, failed, deferred}
 */
/**
 * First-come-first-served budget allocation, oldest submission first.
 *
 * Only 'active' submissions from participations that are not 'kicked' earn.
 * Views only ever grow, so an earlier submission's allocation never shrinks —
 * later submissions simply stop earning once the budget is exhausted.
 *
 * Locked submissions are settled history: their amount was already paid out,
 * so it is never recalculated and always consumes budget, whatever happens to
 * the clip or the campaign afterwards. A locked clip is closed -- views it
 * gains later earn nothing.
 */
export async function allocateCampaignEarnings(db, campaignId) {
  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').bind(campaignId).first();
  if (!campaign) return;

  // Both platforms share one budget and one FCFS queue, ordered by when the
  // clip reached ClipGrow -- an Instagram Reel and a YouTube Short compete for
  // the same pool on equal terms.
  const { results: submissions } = await db.prepare(
    `SELECT s.id, s.views, s.earning, s.clipper_earning, s.locked_at, s.locked_earning, s.eligible, s.frozen_earning,
            s.status AS sub_status, COALESCE(p.status, 'active') AS part_status
     FROM submissions s
     LEFT JOIN participations p ON p.clipper_id = s.clipper_id AND p.campaign_id = s.campaign_id
     WHERE s.campaign_id = ?
     ORDER BY s.created_at ASC, s.id ASC`
  ).bind(campaignId).all();

  const cpm = campaign.cpm || 0;
  const minViews = campaign.min_views == null ? 0 : campaign.min_views;
  const maxPerVideo = maxPayoutPerVideo(campaign);
  const rows = submissions || [];

  // Settled money is committed, so it comes off the budget before anything
  // else is priced. Deducting it in FCFS order instead would let an older
  // unlocked clip win budget that a newer, already-paid clip had spent --
  // pushing total spend above the budget. This also means that if the budget
  // is later cut below what has already been paid out, nothing new earns
  // rather than the books going further into deficit.
  const lockedTotal = rows.reduce((n, s) => n + (s.locked_at ? (s.locked_earning || 0) : 0), 0);
  let remaining = Math.max(0, (campaign.budget || 0) - lockedTotal);
  const updates = [];

  for (const sub of rows) {
    let allocated;
    if (sub.locked_at) {
      // Settled and paid. Historical fact -- never re-priced, and immune to
      // any later status change on the clip. Already deducted above.
      allocated = sub.locked_earning || 0;
    } else if (sub.sub_status !== 'active') {
      // Paused (under review) or disqualified by an admin: earns nothing and
      // hands its share of the budget back to the pool.
      allocated = 0;
    } else if (sub.eligible === 0) {
      // The platform adapter ruled this clip out at import time -- a YouTube
      // upload that is not a Short. Tracked and visible, but never earns.
      allocated = 0;
    } else if (sub.part_status === 'kicked') {
      // Removed from the campaign: earnings freeze at what they had already
      // accrued. The money is still owed, so it still consumes budget.
      //
      // Read from frozen_earning, written once when the clipper was kicked.
      // Using `earning` here made this a ratchet: it is the previous pass's
      // OUTPUT, so a pass run while the budget was short wrote the value down,
      // and restoring the budget could never bring it back. frozen_earning does
      // not move, so repricing is idempotent -- the clamp below can shrink what
      // is payable right now without destroying the underlying figure.
      const frozen = sub.frozen_earning != null ? sub.frozen_earning : (sub.earning || 0);
      allocated = Math.min(frozen, Math.max(0, remaining));
      remaining -= allocated;
    } else if (sub.views < minViews) {
      // Under the campaign's minimum: tracked and shown, but earns nothing yet.
      allocated = 0;
    } else {
      // Threshold cleared -- earns on the FULL view count, not just the excess.
      // The rounding rule lives in cpmEarning; this used to be a second copy of
      // it, with payableClips holding a third, and a comment warning that a
      // drift between them would make the displayed amount stop matching the
      // amount a clip is actually locked at.
      let naive = cpmEarning(sub.views, cpm);
      // Per-video ceiling from the campaign blueprint, when one is set.
      if (maxPerVideo > 0) naive = Math.min(naive, maxPerVideo);
      allocated = Math.max(0, Math.min(naive, Math.max(0, remaining)));
      remaining -= allocated;
    }

    // The clipper is paid in complete CPM-multiples of the billable amount
    // above -- never the billable amount itself. Applies uniformly to every
    // branch (paused/disqualified/kicked/below-min all already produce
    // allocated=0, which floors to clipper_earning=0 the same way). Locked
    // clips are the one exception: their clipper_earning was fixed forever
    // at settlement (src/payouts.js), never touched by any later pass.
    const clipperAllocated = sub.locked_at ? null : (cpm > 0 ? Math.floor(allocated / cpm) * cpm : 0);

    if (allocated !== sub.earning || clipperAllocated !== sub.clipper_earning) {
      updates.push(db.prepare(
        'UPDATE submissions SET earning = ?, clipper_earning = ? WHERE id = ? AND locked_at IS NULL'
      ).bind(allocated, clipperAllocated, sub.id));
    }
  }
  if (updates.length) await db.batch(updates);

  // Auto-completion: the campaign ends itself the instant remaining budget
  // can't fund even one more full CPM unit for anyone, no admin click
  // required -- confirmed explicitly by the founder. Layered ahead of the
  // existing budget_full <-> active toggle below (which still handles every
  // case this stricter check doesn't reach) and reversible: a top-up that
  // brings remaining back above one CPM unit reopens it automatically. A
  // campaign manually "Marked Over" (completed_reason = 'manual') is never
  // touched by this -- budget math doesn't get to undo a deliberate human
  // decision made for unrelated reasons.
  const autoExhausted = campaign.status === 'completed' && campaign.completed_reason === 'budget_exhausted';
  if (cpm > 0 && remaining < cpm && campaign.completed_reason !== 'manual' && !autoExhausted) {
    await db.prepare("UPDATE campaigns SET status = 'completed', completed_reason = 'budget_exhausted' WHERE id = ?")
      .bind(campaignId).run();
    await logAction(db, {
      staffType: 'system', staffName: 'Automatic (budget)', action: 'campaign_auto_completed',
      targetType: 'campaign', targetId: campaignId, targetLabel: campaign.name,
      detail: `Remaining budget (₹${remaining}) can no longer fund a full CPM unit (₹${cpm}) for anyone.`
    });
  } else if (cpm > 0 && remaining >= cpm && autoExhausted) {
    // A top-up arrived. Reopens automatically -- this ending was never a
    // deliberate human decision to begin with.
    await db.prepare("UPDATE campaigns SET status = 'active', completed_reason = NULL WHERE id = ?")
      .bind(campaignId).run();
    await logAction(db, {
      staffType: 'system', staffName: 'Automatic (budget)', action: 'campaign_auto_reopened',
      targetType: 'campaign', targetId: campaignId, targetLabel: campaign.name,
      detail: `A budget top-up brought remaining (₹${remaining}) back above one CPM unit (₹${cpm}).`
    });
  } else if (campaign.status === 'active' && remaining <= 0) {
    await db.prepare("UPDATE campaigns SET status = 'budget_full' WHERE id = ?").bind(campaignId).run();
  } else if (campaign.status === 'budget_full' && remaining > 0) {
    await db.prepare("UPDATE campaigns SET status = 'active' WHERE id = ?").bind(campaignId).run();
  }
}

/** Recomputes allocation only — used after moderation changes, no API calls. */
export async function reallocateCampaign(db, campaignId) {
  await allocateCampaignEarnings(db, campaignId);
}

/**
 * Re-prices every open campaign. Pure D1 work with no external calls, so it
 * costs nothing against the per-invocation subrequest budget -- which is why a
 * finished refresh job can just do all of them rather than tracking exactly
 * which campaigns it touched and risking one being missed.
 */
export async function reallocateAll(db) {
  const { results } = await db.prepare("SELECT id FROM campaigns WHERE status != 'completed'").all();
  for (const c of results || []) await allocateCampaignEarnings(db, c.id);
}
