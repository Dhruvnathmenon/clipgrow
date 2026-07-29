import { fetchMediaViews, refreshLongLivedToken, listRecentMedia, isVideoMedia, IgError } from './instagram.js';

const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function markAccount(db, accountId, { status, code }) {
  await db.prepare(
    'UPDATE social_accounts SET status = ?, last_error_code = ?, last_error_at = ?, last_checked_at = ? WHERE id = ?'
  ).bind(status, code || null, code ? Date.now() : null, Date.now(), accountId).run();
}

/** Refreshes long-lived tokens before they lapse; flags accounts that can't be refreshed. */
export async function refreshExpiringTokens(db) {
  const { results } = await db.prepare(
    `SELECT id, access_token FROM social_accounts
     WHERE platform = 'instagram' AND status = 'connected'
       AND access_token IS NOT NULL AND token_expires_at IS NOT NULL AND token_expires_at < ?`
  ).bind(Date.now() + REFRESH_WINDOW_MS).all();

  for (const acct of results || []) {
    try {
      const refreshed = await refreshLongLivedToken(acct.access_token);
      await db.prepare(
        'UPDATE social_accounts SET access_token = ?, token_expires_at = ?, last_checked_at = ?, last_error_code = NULL WHERE id = ?'
      ).bind(refreshed.access_token, Date.now() + (refreshed.expires_in || 0) * 1000, Date.now(), acct.id).run();
    } catch (e) {
      const needsReauth = e instanceof IgError && e.needsReauth;
      await markAccount(db, acct.id, {
        status: needsReauth ? 'needs_reauth' : 'connected',
        code: e.code || 'UNKNOWN'
      });
    }
  }
}

/**
 * Pulls fresh view counts for every countable submission in a campaign.
 * One failing account never blocks the rest: errors are recorded per row and
 * the loop continues.
 */
export async function syncSubmissionViews(db, campaignId) {
  const { results } = await db.prepare(
    `SELECT s.id, s.ig_media_id, a.id AS account_id, a.access_token, a.status AS account_status
     FROM submissions s
     LEFT JOIN social_accounts a ON a.id = s.account_id
     WHERE s.campaign_id = ? AND s.status = 'active'`
  ).bind(campaignId).all();

  for (const sub of results || []) {
    if (!sub.access_token || sub.account_status === 'revoked') {
      await db.prepare('UPDATE submissions SET sync_error = ? WHERE id = ?')
        .bind('NO_ACCOUNT', sub.id).run();
      continue;
    }
    try {
      const views = await fetchMediaViews(sub.ig_media_id, sub.access_token);
      await db.prepare('UPDATE submissions SET views = ?, last_synced_at = ?, sync_error = NULL WHERE id = ?')
        .bind(views, Date.now(), sub.id).run();
      if (sub.account_status !== 'connected') await markAccount(db, sub.account_id, { status: 'connected', code: null });
    } catch (e) {
      const code = e.code || 'UNKNOWN';
      await db.prepare('UPDATE submissions SET sync_error = ?, last_synced_at = ? WHERE id = ?')
        .bind(code, Date.now(), sub.id).run();
      if (e instanceof IgError && e.needsReauth && sub.account_id) {
        await markAccount(db, sub.account_id, { status: 'needs_reauth', code });
      }
    }
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
export async function autoImportClips(db, clipperId = null) {
  const { results } = await db.prepare(
    `SELECT a.id AS account_id, a.external_id, a.access_token, a.connected_at,
            p.clipper_id, p.campaign_id
     FROM social_accounts a
     JOIN participations p ON p.account_id = a.id
     JOIN campaigns c ON c.id = p.campaign_id
     WHERE a.platform = 'instagram' AND a.status = 'connected' AND a.access_token IS NOT NULL
       AND p.status = 'active' AND c.status != 'completed'
       ${clipperId ? 'AND p.clipper_id = ?' : ''}`
  ).bind(...(clipperId ? [clipperId] : [])).all();

  const campaigns = new Set();
  let imported = 0;

  for (const row of results || []) {
    try {
      const media = await listRecentMedia(row.external_id, row.access_token, { sinceTs: row.connected_at || 0 });
      for (const m of media) {
        if (!isVideoMedia(m)) continue;
        const seen = await db.prepare('SELECT id FROM submissions WHERE ig_media_id = ?').bind(m.id).first();
        if (seen) continue;
        await db.prepare(
          `INSERT INTO submissions
             (clipper_id, campaign_id, account_id, ig_media_id, permalink, views, earning, status,
              media_product_type, thumbnail_url, posted_at, created_at, source)
           VALUES (?, ?, ?, ?, ?, 0, 0, 'active', ?, ?, ?, ?, 'auto')`
        ).bind(
          row.clipper_id, row.campaign_id, row.account_id, m.id, m.permalink || '',
          m.media_product_type || m.media_type || null,
          m.thumbnail_url || m.media_url || null,
          m.timestamp ? Date.parse(m.timestamp) : Date.now(),
          Date.now()
        ).run();
        campaigns.add(row.campaign_id);
        imported++;
      }
    } catch (e) {
      // One unreachable account must never stop the rest importing.
      const code = e.code || 'UNKNOWN';
      if (e instanceof IgError && e.needsReauth) {
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

export async function syncClipperViews(db, clipperId) {
  // Pick up anything newly posted before reading view counts, so a brand-new
  // Reel lands with real numbers on the very first refresh.
  let autoImported = 0;
  try {
    const res = await autoImportClips(db, clipperId);
    autoImported = res.imported;
  } catch { /* import failures must not block the view sync */ }

  const { results } = await db.prepare(
    `SELECT s.id, s.ig_media_id, s.campaign_id, a.id AS account_id, a.access_token, a.status AS account_status
     FROM submissions s
     LEFT JOIN social_accounts a ON a.id = s.account_id
     WHERE s.clipper_id = ? AND s.status = 'active'
     ORDER BY s.created_at DESC
     LIMIT ?`
  ).bind(clipperId, MANUAL_SYNC_MAX_CLIPS).all();

  const campaigns = new Set();
  let synced = 0, failed = 0;

  for (const sub of results || []) {
    campaigns.add(sub.campaign_id);
    if (!sub.access_token || sub.account_status === 'revoked') {
      await db.prepare('UPDATE submissions SET sync_error = ? WHERE id = ?').bind('NO_ACCOUNT', sub.id).run();
      failed++;
      continue;
    }
    try {
      const views = await fetchMediaViews(sub.ig_media_id, sub.access_token);
      await db.prepare('UPDATE submissions SET views = ?, last_synced_at = ?, sync_error = NULL WHERE id = ?')
        .bind(views, Date.now(), sub.id).run();
      if (sub.account_status !== 'connected') await markAccount(db, sub.account_id, { status: 'connected', code: null });
      synced++;
    } catch (e) {
      const code = e.code || 'UNKNOWN';
      await db.prepare('UPDATE submissions SET sync_error = ?, last_synced_at = ? WHERE id = ?')
        .bind(code, Date.now(), sub.id).run();
      if (e instanceof IgError && e.needsReauth && sub.account_id) {
        await markAccount(db, sub.account_id, { status: 'needs_reauth', code });
      }
      failed++;
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
 */
export async function allocateCampaignEarnings(db, campaignId) {
  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').bind(campaignId).first();
  if (!campaign) return;

  const { results: submissions } = await db.prepare(
    `SELECT s.id, s.views, s.earning, s.status AS sub_status, COALESCE(p.status, 'active') AS part_status
     FROM submissions s
     LEFT JOIN participations p ON p.clipper_id = s.clipper_id AND p.campaign_id = s.campaign_id
     WHERE s.campaign_id = ?
     ORDER BY s.created_at ASC, s.id ASC`
  ).bind(campaignId).all();

  const cpm = campaign.cpm || 0;
  let remaining = campaign.budget || 0;
  const updates = [];

  for (const sub of submissions || []) {
    let allocated;
    if (sub.sub_status !== 'active') {
      // Paused (under review) or disqualified by an admin: earns nothing and
      // hands its share of the budget back to the pool.
      allocated = 0;
    } else if (sub.part_status === 'kicked') {
      // Removed from the campaign: earnings freeze at what they had already
      // accrued. The money is still owed, so it still consumes budget.
      allocated = Math.min(sub.earning || 0, remaining);
      remaining -= allocated;
    } else {
      const naive = Math.floor((sub.views / 1000) * cpm);
      allocated = Math.max(0, Math.min(naive, remaining));
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

export async function syncAllCampaigns(db) {
  const summary = { campaigns: 0, imported: 0, errors: [] };
  try {
    await refreshExpiringTokens(db);
  } catch (e) {
    summary.errors.push(`token refresh: ${e.message}`);
  }

  // Import first so new posts get view counts in this same pass.
  try {
    const res = await autoImportClips(db);
    summary.imported = res.imported;
  } catch (e) {
    summary.errors.push(`auto-import: ${e.message}`);
  }

  const { results: campaigns } = await db
    .prepare("SELECT id FROM campaigns WHERE status != 'completed'")
    .all();

  for (const campaign of campaigns || []) {
    try {
      await syncSubmissionViews(db, campaign.id);
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
