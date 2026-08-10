import { maxPayoutPerVideo } from './db.js';
import { getAdapter, campaignPlatforms } from './platforms.js';

const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Instagram tokens last 60 days, so a weekly renewal window is plenty. Google
// access tokens last about an hour and are renewed inline by the adapter when
// a call needs one, so YouTube accounts are deliberately not swept here.
const PROACTIVE_REFRESH_PLATFORMS = ['instagram'];

async function markAccount(db, accountId, { status, code }) {
  await db.prepare(
    'UPDATE social_accounts SET status = ?, last_error_code = ?, last_error_at = ?, last_checked_at = ? WHERE id = ?'
  ).bind(status, code || null, code ? Date.now() : null, Date.now(), accountId).run();
}

async function saveRefreshedToken(db, accountId, fresh) {
  await db.prepare(
    `UPDATE social_accounts
       SET access_token = ?, refresh_token = COALESCE(?, refresh_token),
           token_expires_at = ?, last_checked_at = ?, last_error_code = NULL, status = 'connected'
     WHERE id = ?`
  ).bind(fresh.access_token, fresh.refresh_token || null, fresh.expires_at || null, Date.now(), accountId).run();
}

/**
 * Runs a call with a valid token for this account, renewing and persisting it
 * first if the platform needs that. Keeps token mechanics out of every call
 * site, and means a mid-sync expiry never surfaces as a broken clip.
 */
function withAccount(db, env, account, fn) {
  const adapter = getAdapter(account.platform);
  return adapter.withFreshToken(
    account,
    env,
    (token) => fn({ ...account, access_token: token }),
    async (fresh) => { await saveRefreshedToken(db, account.id, fresh); }
  );
}

/** Renews tokens before they lapse; flags accounts that cannot be renewed. */
export async function refreshExpiringTokens(db, env) {
  const placeholders = PROACTIVE_REFRESH_PLATFORMS.map(() => '?').join(',');
  const { results } = await db.prepare(
    `SELECT * FROM social_accounts
     WHERE platform IN (${placeholders}) AND status = 'connected'
       AND access_token IS NOT NULL AND token_expires_at IS NOT NULL AND token_expires_at < ?`
  ).bind(...PROACTIVE_REFRESH_PLATFORMS, Date.now() + REFRESH_WINDOW_MS).all();

  for (const acct of results || []) {
    try {
      const adapter = getAdapter(acct.platform);
      const fresh = await adapter.refreshToken(acct, env);
      await saveRefreshedToken(db, acct.id, fresh);
    } catch (e) {
      await markAccount(db, acct.id, {
        status: e && e.needsReauth ? 'needs_reauth' : 'connected',
        code: (e && e.code) || 'UNKNOWN'
      });
    }
  }
}

/**
 * Fetches views for one account's clips in a single batched call and writes
 * the results.
 *
 * Batching is what makes YouTube affordable: videos.list returns up to 50 ids
 * for one quota unit, where Instagram costs one call per clip. Both go through
 * the same adapter interface, so this code does not care which is which.
 *
 * A clip whose id comes back missing from the response is reported as removed
 * rather than left silently stale -- that is the honest signal when a video has
 * been deleted or made private.
 */
async function syncAccountClips(db, env, account, subs) {
  let synced = 0, failed = 0;

  if (!account.access_token || account.status === 'revoked') {
    for (const s of subs) {
      await db.prepare('UPDATE submissions SET sync_error = ? WHERE id = ?').bind('NO_ACCOUNT', s.id).run();
    }
    return { synced: 0, failed: subs.length };
  }

  const adapter = getAdapter(account.platform);
  const ids = subs.map(s => s.ig_media_id);

  let views;
  try {
    views = await withAccount(db, env, account, (acct) => adapter.fetchViews(acct, ids, env));
  } catch (e) {
    // The whole batch failed, so every clip in it carries the same reason.
    const code = (e && e.code) || 'UNKNOWN';
    for (const s of subs) {
      await db.prepare('UPDATE submissions SET sync_error = ?, last_synced_at = ? WHERE id = ?')
        .bind(code, Date.now(), s.id).run();
    }
    if (e && e.needsReauth) await markAccount(db, account.id, { status: 'needs_reauth', code });
    return { synced: 0, failed: subs.length };
  }

  const now = Date.now();
  for (const s of subs) {
    const v = views.get(s.ig_media_id);
    if (v == null) {
      await db.prepare('UPDATE submissions SET sync_error = ?, last_synced_at = ? WHERE id = ?')
        .bind('MEDIA_NOT_FOUND', now, s.id).run();
      failed++;
      continue;
    }
    await db.prepare(
      'UPDATE submissions SET views = ?, last_synced_at = ?, last_ok_sync_at = ?, sync_error = NULL WHERE id = ?'
    ).bind(v, now, now, s.id).run();
    synced++;
  }

  if (synced > 0 && account.status !== 'connected') {
    await markAccount(db, account.id, { status: 'connected', code: null });
  }
  return { synced, failed };
}

/** Groups submission rows by their account, so each account syncs in one batch. */
async function groupByAccount(db, rows) {
  const byAccount = new Map();
  const orphans = [];
  for (const r of rows || []) {
    if (!r.account_id) { orphans.push(r); continue; }
    if (!byAccount.has(r.account_id)) byAccount.set(r.account_id, []);
    byAccount.get(r.account_id).push(r);
  }

  const groups = [];
  for (const [accountId, subs] of byAccount) {
    const account = await db.prepare('SELECT * FROM social_accounts WHERE id = ?').bind(accountId).first();
    if (!account) { orphans.push(...subs); continue; }
    groups.push({ account, subs });
  }
  return { groups, orphans };
}

/**
 * Pulls fresh view counts for every countable submission in a campaign.
 * One failing account never blocks the rest: errors are recorded per row and
 * the loop continues.
 */
export async function syncSubmissionViews(db, campaignId, env) {
  // Locked clips are closed out: their amount is settled and further views
  // change nothing, so re-fetching them would only burn API quota.
  const { results } = await db.prepare(
    `SELECT s.id, s.ig_media_id, s.account_id
     FROM submissions s
     WHERE s.campaign_id = ? AND s.status = 'active' AND s.locked_at IS NULL`
  ).bind(campaignId).all();

  const { groups, orphans } = await groupByAccount(db, results);
  for (const o of orphans) {
    await db.prepare('UPDATE submissions SET sync_error = ? WHERE id = ?').bind('NO_ACCOUNT', o.id).run();
  }
  // One failing account must never stop the others syncing.
  for (const g of groups) {
    try {
      await syncAccountClips(db, env, g.account, g.subs);
    } catch { /* already recorded per row */ }
  }
}

/**
 * Pulls newly-posted Reels from every connected account into its campaign.
 *
 * Each campaign is worked from its own dedicated account, so anything new on
 * that account belongs to that campaign -- the clipper posts to Instagram and
 * the clip appears here on its own, no link pasting.
 *
 * Guardrails:
 *  - only media posted strictly after `connected_at` (no back-dating an old
 *    viral Reel into a campaign for an instant payout)
 *  - Reels/video only (photos carry no view metric)
 *  - skips ig_media_ids already recorded, so re-runs never double-count
 *  - skips paused/kicked participations and finished campaigns
 *
 * @param clipperId optional -- restrict to one clipper (manual refresh).
 */
export async function autoImportClips(db, clipperId = null, env = {}) {
  // Reads the participation_accounts join table (migration 012) rather than
  // participations.account_id, so a campaign can pull from an Instagram
  // account and a YouTube channel at the same time.
  const { results } = await db.prepare(
    `SELECT a.id AS account_id, a.platform, a.external_id, a.access_token, a.refresh_token,
            a.token_expires_at, a.meta_json, a.connected_at, a.status,
            p.clipper_id, p.campaign_id, c.allowed_platforms
     FROM participation_accounts pa
     JOIN social_accounts a ON a.id = pa.account_id
     JOIN participations p ON p.id = pa.participation_id
     JOIN campaigns c ON c.id = p.campaign_id
     WHERE a.status = 'connected' AND a.access_token IS NOT NULL
       AND p.status = 'active' AND c.status != 'completed'
       ${clipperId ? 'AND p.clipper_id = ?' : ''}`
  ).bind(...(clipperId ? [clipperId] : [])).all();

  const campaigns = new Set();
  let imported = 0;

  for (const row of results || []) {
    // A campaign only accepts the platforms it was configured for, so a clip
    // can never arrive on a platform the brand did not agree to.
    if (!campaignPlatforms(row).includes(row.platform)) continue;

    try {
      const adapter = getAdapter(row.platform);
      // sinceTs is the guardrail: only media published strictly after the
      // account was connected. Without it, connecting an account that already
      // has an old viral post would claim a campaign's budget instantly.
      const media = await withAccount(db, env, row,
        (acct) => adapter.listRecent(acct, { sinceTs: row.connected_at || 0 }, env));

      for (const m of media) {
        const seen = await db.prepare(
          'SELECT id FROM submissions WHERE platform = ? AND ig_media_id = ?'
        ).bind(row.platform, m.external_id).first();
        if (seen) continue;

        await db.prepare(
          `INSERT OR IGNORE INTO submissions
             (clipper_id, campaign_id, account_id, platform, ig_media_id, permalink, views, earning, status,
              media_product_type, thumbnail_url, posted_at, created_at, source,
              duration_seconds, is_short, eligible)
           VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'active', ?, ?, ?, ?, 'auto', ?, ?, ?)`
        ).bind(
          row.clipper_id, row.campaign_id, row.account_id, row.platform,
          m.external_id, m.permalink || '',
          m.media_type || null, m.thumbnail_url || null,
          m.posted_at || Date.now(), Date.now(),
          m.duration_seconds == null ? null : m.duration_seconds,
          m.is_short == null ? null : (m.is_short ? 1 : 0),
          m.eligible === false ? 0 : 1
        ).run();
        campaigns.add(row.campaign_id);
        imported++;
      }
    } catch (e) {
      // One unreachable account must never stop the rest importing.
      const code = (e && e.code) || 'UNKNOWN';
      if (e && e.needsReauth) {
        await markAccount(db, row.account_id, { status: 'needs_reauth', code });
      }
    }
  }

  return { imported, campaigns: [...campaigns] };
}

/**
 * Syncs only one clipper's clips, then reallocates every campaign they touched.
 *
 * Backs the manual refresh button. Capped at MANUAL_SYNC_MAX_CLIPS so a clipper
 * with a huge back catalogue can't burn the app's Instagram rate limit in one
 * click -- the 6-hourly cron still covers anything beyond the cap.
 */
export const MANUAL_SYNC_MAX_CLIPS = 40;

export async function syncClipperViews(db, clipperId, env = {}) {
  // Pick up anything newly posted before reading view counts, so a brand-new
  // clip lands with real numbers on the very first refresh.
  let autoImported = 0;
  try {
    const res = await autoImportClips(db, clipperId, env);
    autoImported = res.imported;
  } catch { /* import failures must not block the view sync */ }

  const { results } = await db.prepare(
    `SELECT s.id, s.ig_media_id, s.campaign_id, s.account_id
     FROM submissions s
     WHERE s.clipper_id = ? AND s.status = 'active' AND s.locked_at IS NULL
     ORDER BY s.created_at DESC
     LIMIT ?`
  ).bind(clipperId, MANUAL_SYNC_MAX_CLIPS).all();

  const campaigns = new Set((results || []).map(r => r.campaign_id));
  let synced = 0, failed = 0;

  const { groups, orphans } = await groupByAccount(db, results);
  for (const o of orphans) {
    await db.prepare('UPDATE submissions SET sync_error = ? WHERE id = ?').bind('NO_ACCOUNT', o.id).run();
    failed++;
  }
  for (const g of groups) {
    try {
      const r = await syncAccountClips(db, env, g.account, g.subs);
      synced += r.synced; failed += r.failed;
    } catch {
      failed += g.subs.length;
    }
  }

  // Allocation is campaign-wide, so refreshing one clipper can shift others'
  // positions in the same budget -- recompute each affected campaign in full.
  for (const campaignId of campaigns) {
    await allocateCampaignEarnings(db, campaignId);
  }

  return { synced, failed, clips: (results || []).length, imported: autoImported };
}

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
    `SELECT s.id, s.views, s.earning, s.locked_at, s.locked_earning, s.eligible,
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
      allocated = Math.min(sub.earning || 0, Math.max(0, remaining));
      remaining -= allocated;
    } else if (sub.views < minViews) {
      // Under the campaign's minimum: tracked and shown, but earns nothing yet.
      allocated = 0;
    } else {
      // Threshold cleared -- earns on the FULL view count, not just the excess.
      let naive = Math.floor((sub.views / 1000) * cpm);
      // Per-video ceiling from the campaign blueprint, when one is set.
      if (maxPerVideo > 0) naive = Math.min(naive, maxPerVideo);
      allocated = Math.max(0, Math.min(naive, Math.max(0, remaining)));
      remaining -= allocated;
    }
    if (allocated !== sub.earning) {
      updates.push(db.prepare('UPDATE submissions SET earning = ? WHERE id = ?').bind(allocated, sub.id));
    }
  }
  if (updates.length) await db.batch(updates);

  if (campaign.status === 'active' && remaining <= 0) {
    await db.prepare("UPDATE campaigns SET status = 'budget_full' WHERE id = ?").bind(campaignId).run();
  } else if (campaign.status === 'budget_full' && remaining > 0) {
    await db.prepare("UPDATE campaigns SET status = 'active' WHERE id = ?").bind(campaignId).run();
  }
}

export async function syncAllCampaigns(db, env = {}) {
  const summary = { campaigns: 0, imported: 0, errors: [] };
  try {
    await refreshExpiringTokens(db, env);
  } catch (e) {
    summary.errors.push(`token refresh: ${e.message}`);
  }

  // Import first so new posts get view counts in this same pass.
  try {
    const res = await autoImportClips(db, null, env);
    summary.imported = res.imported;
  } catch (e) {
    summary.errors.push(`auto-import: ${e.message}`);
  }

  const { results: campaigns } = await db
    .prepare("SELECT id FROM campaigns WHERE status != 'completed'")
    .all();

  for (const campaign of campaigns || []) {
    try {
      await syncSubmissionViews(db, campaign.id, env);
      await allocateCampaignEarnings(db, campaign.id);
      summary.campaigns++;
    } catch (e) {
      summary.errors.push(`campaign ${campaign.id}: ${e.message}`);
    }
  }
  return summary;
}

/** Recomputes allocation only — used after moderation changes, no API calls. */
export async function reallocateCampaign(db, campaignId) {
  await allocateCampaignEarnings(db, campaignId);
}
