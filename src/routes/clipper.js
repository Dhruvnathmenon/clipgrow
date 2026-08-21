import { json, err, readJson, matchPath } from '../http.js';
import { createSessionCookie, requireClipper, verifyPassword, clearCookieHeader } from '../auth.js';
import {
  now, getClipperByUsername, getClipperById, getCampaignById, getParticipation,
  publicCampaign, publicAccount, campaignSpend, clipperFinancials,
  clipperStreak, allClipperStreaks, clipperTotals, listParticipationAccounts, getParticipationAccount,
  unlinkParticipationAccount
} from '../db.js';
import { clipState, clipStateMessage } from '../clipstate.js';
import { getAdapter, campaignPlatforms, configuredPlatforms, platformLabel, PLATFORMS } from '../platforms.js';
import {
  accessState, accessGuidance, submitAccessRequest, normaliseIdentifier, validateIdentifier
} from '../access.js';
import { IgError } from '../instagram.js';
import { captureThumbnail } from '../media.js';
import { syncClipperViews, syncAccountClips, syncAccountClipsStream, reallocateCampaign } from '../earnings.js';
import { getBudget, CLIP_COOLDOWN_MS, MAX_CLIPS_FOR_FULL_REFRESH } from '../rate-budget.js';

// Manual refresh cooldown. Instagram allows roughly 200 calls per user per
// hour and each clip costs one call, so this keeps a clipper well inside it
// even with a full 40-clip refresh every time.
const MANUAL_SYNC_COOLDOWN_MS = 5 * 60 * 1000;

// Clip status lives in src/clipstate.js so the clipper dashboard, the admin
// panel and the client portal can never describe the same clip differently.

// Both platform modules raise errors carrying the same shape (code, message,
// fix, needsReauth), so one responder serves both.
function platformErrorResponse(e, status = 400) {
  if (e && e.code && e.fix !== undefined) {
    return json({ error: e.message, fix: e.fix, code: e.code, needs_reauth: !!e.needsReauth }, status);
  }
  if (e instanceof IgError) return json({ error: e.message, fix: e.fix, code: e.code, needs_reauth: e.needsReauth }, status);
  return err((e && e.message) || 'Something went wrong', status);
}

/**
 * Which platform a pasted link belongs to. Detected from the URL rather than
 * trusted from the client, so a clipper cannot file a YouTube link against an
 * Instagram account (or vice versa) by tampering with the request.
 */
function detectPlatform(postUrl, fallback) {
  const s = String(postUrl || '');
  if (/youtube\.com|youtu\.be/i.test(s)) return 'youtube';
  if (/instagram\.com/i.test(s)) return 'instagram';
  return PLATFORMS.includes(fallback) ? fallback : null;
}

export async function handleClipper(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/clipper/login' && method === 'POST') {
    const { username, password } = await readJson(request);
    if (!username || !password) return err('Enter your username and password');
    const clipper = await getClipperByUsername(env.DB, username);
    if (!clipper) return err('Invalid username or password', 401);
    // Disabled clippers may still sign in, read-only, so they can verify any
    // balance still owed to them.
    const valid = await verifyPassword(password, clipper.password_hash, clipper.password_salt);
    if (!valid) return err('Invalid username or password', 401);
    const cookie = await createSessionCookie('clipper', clipper.id, env.SESSION_SECRET);
    return json({ ok: true }, 200, { 'Set-Cookie': cookie });
  }

  if (pathname === '/api/clipper/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookieHeader('cg_session') });
  }

  if (!pathname.startsWith('/api/clipper/')) return null;

  const session = await requireClipper(request, env);
  if (!session) return err('Unauthorized', 401);
  const clipperId = Number(session.sub);

  const me = await getClipperById(env.DB, clipperId);
  if (!me) return json({ error: 'Account no longer exists' }, 401, { 'Set-Cookie': clearCookieHeader('cg_session') });

  // A disabled account keeps read access to its own numbers but cannot act.
  const readOnly = me.status !== 'active';
  const blockIfReadOnly = () => readOnly
    ? err('Your account is disabled, so this action is not available. You can still see everything you have earned. Contact the ClipGrow admin.', 403)
    : null;

  // ------------------------------------------------------------- profile
  if (pathname === '/api/clipper/me' && method === 'GET') {
    const [money, streak, totals] = await Promise.all([
      clipperFinancials(env.DB, clipperId),
      clipperStreak(env.DB, clipperId),
      clipperTotals(env.DB, clipperId)
    ]);
    return json({
      clipper: {
        id: me.id, username: me.username,
        display_name: me.display_name || me.username,
        status: me.status, read_only: readOnly
      },
      money, streak, totals,
      refresh: {
        cooldown_ms: MANUAL_SYNC_COOLDOWN_MS,
        next_allowed_at: (me.last_manual_sync_at || 0) + MANUAL_SYNC_COOLDOWN_MS
      }
    });
  }

  // Every social account this clipper has linked, and which campaign each drives.
  if (pathname === '/api/clipper/accounts' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT a.*, c.name AS campaign_name, c.id AS campaign_id
       FROM social_accounts a
       LEFT JOIN participations p ON p.account_id = a.id
       LEFT JOIN campaigns c ON c.id = p.campaign_id
       WHERE a.clipper_id = ? ORDER BY a.connected_at DESC`
    ).bind(clipperId).all();
    return json({
      accounts: (results || []).map(r => ({
        ...publicAccount(r),
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name
      }))
    });
  }

  if (pathname === '/api/clipper/payments' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.amount, p.method, p.reference, p.note, p.paid_at, c.name AS campaign_name
       FROM payments p LEFT JOIN campaigns c ON c.id = p.campaign_id
       WHERE p.clipper_id = ? ORDER BY p.paid_at DESC`
    ).bind(clipperId).all();
    return json({ payments: results || [], money: await clipperFinancials(env.DB, clipperId) });
  }

  // ------------------------------------------------------------ campaigns
  if (pathname === '/api/clipper/campaigns' && method === 'GET') {
    const { results: campaigns } = await env.DB
      .prepare("SELECT * FROM campaigns WHERE status != 'completed' ORDER BY created_at DESC").all();
    const { results: parts } = await env.DB
      .prepare('SELECT * FROM participations WHERE clipper_id = ?').bind(clipperId).all();
    const byCampaign = new Map((parts || []).map(p => [p.campaign_id, p]));

    // Every access request this clipper has, fetched once and indexed, rather
    // than a query per campaign per platform.
    const { results: reqRows } = await env.DB
      .prepare('SELECT * FROM tester_requests WHERE clipper_id = ? ORDER BY requested_at DESC')
      .bind(clipperId).all();
    const requestByKey = new Map();
    for (const r of reqRows || []) {
      const key = `${r.campaign_id}:${r.platform || 'instagram'}`;
      if (!requestByKey.has(key)) requestByKey.set(key, r);
    }
    const configured = configuredPlatforms(env);

    const out = [];
    for (const c of campaigns || []) {
      const part = byCampaign.get(c.id);
      const allowed = campaignPlatforms(c);

      // One connected account per platform, so a campaign can run Instagram
      // and YouTube at the same time.
      const accounts = {};
      if (part) {
        for (const linked of await listParticipationAccounts(env.DB, part.id)) {
          accounts[linked.linked_platform] = publicAccount(linked);
        }
      }
      const igAccount = accounts.instagram || null;

      // Where this clipper stands on each platform, and the single next thing
      // they should do. Driving the UI from one computed state (rather than
      // the page inferring it from several fields) is what keeps the clipper
      // from ever being offered an action that cannot succeed.
      const access = {};
      if (part && part.status !== 'kicked') {
        for (const plat of allowed) {
          if (!configured.includes(plat)) continue;
          const req = requestByKey.get(`${c.id}:${plat}`) || null;
          const state = accessState(req, accounts[plat]);
          access[plat] = {
            state,
            identifier: req ? (req.identifier || req.ig_username) : null,
            note: req ? req.note : null,
            requested_at: req ? req.requested_at : null,
            ...accessGuidance(state, plat, req)
          };
        }
      }

      const stats = await env.DB.prepare(
        `SELECT COUNT(*) AS videos, COALESCE(SUM(views),0) AS views, COALESCE(SUM(earning),0) AS earned
         FROM submissions WHERE clipper_id = ? AND campaign_id = ? AND status = 'active'`
      ).bind(clipperId, c.id).first();

      const { results: platStats } = await env.DB.prepare(
        `SELECT platform, COUNT(*) AS videos, COALESCE(SUM(views),0) AS views, COALESCE(SUM(earning),0) AS earned
         FROM submissions WHERE clipper_id = ? AND campaign_id = ? AND status = 'active'
         GROUP BY platform`
      ).bind(clipperId, c.id).all();

      out.push({
        ...publicCampaign(c, await campaignSpend(env.DB, c.id)),
        allowed_platforms: allowed,
        platforms_available: allowed.filter(p => configured.includes(p)),
        participation: part
          ? {
              status: part.status, note: part.status_note, joined_at: part.joined_at,
              // Kept for older clients that expect a single Instagram account.
              account: igAccount,
              accounts,
              access
            }
          : null,
        my_stats: { videos: stats.videos, views: stats.views, earned: stats.earned },
        my_stats_by_platform: (platStats || []).reduce((acc, r) => {
          acc[r.platform] = { videos: r.videos, views: r.views, earned: r.earned };
          return acc;
        }, {})
      });
    }
    return json({ campaigns: out, configured_platforms: configured });
  }

  let params = matchPath('/api/clipper/campaigns/:id/join', pathname);
  if (params && method === 'POST') {
    const blocked = blockIfReadOnly();
    if (blocked) return blocked;
    const campaign = await getCampaignById(env.DB, params.id);
    if (!campaign) return err('Campaign not found', 404);
    if (campaign.status === 'completed') return err('This campaign is over and is no longer accepting clippers');
    if (campaign.status === 'budget_full') return err('This campaign\'s budget is fully allocated, so it is closed to new clippers');

    const existing = await getParticipation(env.DB, clipperId, params.id);
    if (existing) {
      if (existing.status === 'kicked') return err('You have been removed from this campaign. Contact the ClipGrow admin.', 403);
      return json({ ok: true, already: true });
    }
    await env.DB.prepare(
      'INSERT INTO participations (clipper_id, campaign_id, status, joined_at) VALUES (?, ?, ?, ?)'
    ).bind(clipperId, params.id, 'active', now()).run();
    return json({ ok: true }, 201);
  }

  // Detach one platform's account from a campaign so a different one can be
  // linked. Scoped per platform, so unlinking YouTube leaves Instagram intact.
  params = matchPath('/api/clipper/campaigns/:id/account', pathname);
  if (params && method === 'DELETE') {
    const blocked = blockIfReadOnly();
    if (blocked) return blocked;
    const platform = String(url.searchParams.get('platform') || 'instagram');
    if (!PLATFORMS.includes(platform)) return err('Unknown platform');

    const part = await getParticipation(env.DB, clipperId, params.id);
    if (!part) return err('You have not joined this campaign', 404);

    // Only this platform's videos block the unlink -- an Instagram clip must
    // not stop a YouTube channel being swapped.
    const used = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM submissions WHERE clipper_id = ? AND campaign_id = ? AND platform = ? AND status = 'active'"
    ).bind(clipperId, params.id, platform).first();
    if (used.n > 0) {
      return err(`You already have ${platformLabel(platform)} videos submitted with this account. Ask the ClipGrow admin to change it so your earnings stay intact.`, 409);
    }
    await unlinkParticipationAccount(env.DB, part.id, platform);
    return json({ ok: true });
  }

  // ------------------------------------------------- Instagram tester queue
  // Manual gate ahead of the OAuth flow: the Meta app is in Development Mode,
  // so an Instagram account must be an accepted app Tester before OAuth can
  // ever succeed for it. The admin adds/confirms testers by hand in Meta; this
  // just tracks that step so a clipper isn't left guessing why Connect fails.
  // Step 1 of connecting: the clipper tells us which account they intend to
  // use, so the admin can grant it access on the platform's side. The old
  // Instagram-only path is kept as an alias so a stale browser tab still works.
  if ((pathname === '/api/clipper/access-request' || pathname === '/api/clipper/tester-request') && method === 'POST') {
    const blocked = blockIfReadOnly();
    if (blocked) return blocked;
    const body = await readJson(request);

    const platform = PLATFORMS.includes(body.platform) ? body.platform : 'instagram';
    const campaignId = body.campaign_id ? Number(body.campaign_id) : null;
    if (!campaignId) return err('Pick a campaign first');

    const campaign = await getCampaignById(env.DB, campaignId);
    if (!campaign) return err('Campaign not found', 404);
    if (!campaignPlatforms(campaign).includes(platform)) {
      return err(`This campaign does not accept ${platformLabel(platform)}.`);
    }

    const part = await getParticipation(env.DB, clipperId, campaignId);
    if (!part) return err('Join this campaign before requesting access');
    if (part.status === 'kicked') return err('You have been removed from this campaign.', 403);

    // `ig_username` is the legacy field name; accept either so an older client
    // posting the old shape still works.
    const raw = body.identifier != null ? body.identifier : body.ig_username;
    const identifier = normaliseIdentifier(platform, raw);
    const invalid = validateIdentifier(platform, identifier);
    if (invalid) return err(invalid);

    const result = await submitAccessRequest(env.DB, { clipperId, campaignId, platform, identifier });
    return json(result, 201);
  }

  // ----------------------------------------------------------- submissions
  // ------------------------------------------------------- manual refresh
  if (pathname === '/api/clipper/refresh' && method === 'POST') {
    const blocked = blockIfReadOnly();
    if (blocked) return blocked;

    const last = me.last_manual_sync_at || 0;
    const waitMs = last + MANUAL_SYNC_COOLDOWN_MS - Date.now();
    if (waitMs > 0) {
      return json({
        error: `Views were just refreshed. You can refresh again in ${Math.ceil(waitMs / 1000)}s.`,
        retry_in_ms: waitMs
      }, 429);
    }

    // Stamp before syncing: if the sync throws halfway, the cooldown still
    // applies, so a failing account can't be retried in a tight loop.
    await env.DB.prepare('UPDATE clippers SET last_manual_sync_at = ? WHERE id = ?')
      .bind(Date.now(), clipperId).run();

    const result = await syncClipperViews(env.DB, clipperId, env);
    const money = await clipperFinancials(env.DB, clipperId);
    const totals = await clipperTotals(env.DB, clipperId);
    return json({ ok: true, ...result, money, totals, cooldown_ms: MANUAL_SYNC_COOLDOWN_MS });
  }

  // --------------------------------------------------- Instagram call budget
  // Real, dynamic usage for the specific Instagram account driving this
  // campaign. The 200-calls/hour limit is per-account, so this is scoped to
  // one campaign's connected account, not the clipper as a whole.
  params = matchPath('/api/clipper/campaigns/:id/budget', pathname);
  if (params && method === 'GET') {
    const part = await getParticipation(env.DB, clipperId, params.id);
    if (!part) return err('You have not joined this campaign', 404);
    const account = await getParticipationAccount(env.DB, part.id, 'instagram');
    if (!account) return json({ applicable: false });

    const { results: subs } = await env.DB.prepare(
      `SELECT id, last_ok_sync_at FROM submissions
       WHERE clipper_id = ? AND campaign_id = ? AND account_id = ? AND status = 'active' AND locked_at IS NULL`
    ).bind(clipperId, params.id, account.id).all();

    const totalClips = (subs || []).length;
    const eligibleNow = (subs || []).filter(
      s => !s.last_ok_sync_at || (Date.now() - s.last_ok_sync_at) >= CLIP_COOLDOWN_MS
    ).length;
    const budget = await getBudget(env.DB, account.id);

    return json({
      applicable: true,
      used: budget.used,
      remaining: budget.remaining,
      limit: budget.limit,
      // Time until the OLDEST call currently counted ages out -- budget frees
      // up continuously as calls roll out of the window, not in one lump at a
      // fixed clock boundary, because Instagram's own limit does not reset
      // that way either.
      reset_in_ms: budget.reset_in_ms,
      total_clips: totalClips,
      eligible_now: eligibleNow,
      too_many_for_full_refresh: totalClips > MAX_CLIPS_FOR_FULL_REFRESH,
      full_refreshes_available: totalClips > 0 ? Math.floor(budget.remaining / totalClips) : null,
      single_refreshes_available: budget.remaining
    });
  }

  // ----------------------------------------------- individual clip refresh
  // Refreshes exactly one clip, spending exactly one call -- the "just check
  // this one" alternative to a full account refresh, for when a clipper only
  // cares about a specific video's current number.
  params = matchPath('/api/clipper/submissions/:id/refresh', pathname);
  if (params && method === 'POST') {
    const blocked = blockIfReadOnly();
    if (blocked) return blocked;

    const sub = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(params.id).first();
    if (!sub || sub.clipper_id !== clipperId) return err('Not found', 404);
    if (sub.locked_at) return err('This clip is locked and settled -- it no longer needs refreshing.');
    if (sub.status !== 'active') return err('This clip is not currently active.');

    const account = await env.DB.prepare('SELECT * FROM social_accounts WHERE id = ?').bind(sub.account_id).first();
    if (!account) return err('No connected account for this clip.', 404);

    // Deliberately no per-clip cooldown here. That cooldown exists to stop an
    // AUTOMATIC full sweep from wastefully re-checking clips it only just
    // looked at -- it was never meant to stop a clipper from choosing to
    // spend one of their own calls on this specific clip right now. The
    // account's real, shared 200/hour budget below is the actual limit; how
    // to spend it is the clipper's call (see src/rate-budget.js).
    if (account.platform === 'instagram') {
      const budget = await getBudget(env.DB, account.id);
      if (budget.remaining < 1) {
        return json({
          error: `This account has used its Instagram refresh budget for the hour. Frees up in ${Math.ceil(budget.reset_in_ms / 60000)}m.`,
          retry_in_ms: budget.reset_in_ms
        }, 429);
      }
    }

    await syncAccountClips(env.DB, env, account,
      [{ id: sub.id, ig_media_id: sub.ig_media_id, last_ok_sync_at: sub.last_ok_sync_at }],
      { skipCooldown: true });
    await reallocateCampaign(env.DB, sub.campaign_id);

    const fresh = await env.DB.prepare('SELECT views, earning, sync_error FROM submissions WHERE id = ?').bind(sub.id).first();
    return json({ ok: true, views: fresh.views, earning: fresh.earning, sync_error: fresh.sync_error });
  }

  // ------------------------------------------------- live full-account refresh
  // Server-Sent Events: fetches this campaign's connected Instagram account's
  // clips one at a time and streams each result as it lands, so a clipper
  // watching a 100+ clip refresh sees real numbers arrive with real progress
  // instead of a blank spinner for however long the whole batch takes.
  params = matchPath('/api/clipper/campaigns/:id/refresh-live', pathname);
  if (params && method === 'GET') {
    const part = await getParticipation(env.DB, clipperId, params.id);
    if (!part) return err('You have not joined this campaign', 404);
    if (readOnly) return err('Your account is disabled, so this action is not available.', 403);
    const account = await getParticipationAccount(env.DB, part.id, 'instagram');
    if (!account) return err('No connected Instagram account for this campaign', 404);

    const { results: subs } = await env.DB.prepare(
      `SELECT id, ig_media_id, last_ok_sync_at FROM submissions
       WHERE clipper_id = ? AND campaign_id = ? AND account_id = ? AND status = 'active' AND locked_at IS NULL`
    ).bind(clipperId, params.id, account.id).all();

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        try {
          for await (const event of syncAccountClipsStream(env.DB, env, account, subs || [])) {
            send(event);
            if (event.type === 'done') await reallocateCampaign(env.DB, Number(params.id));
          }
        } catch (e) {
          send({ type: 'error', message: (e && e.message) || 'Sync failed' });
        } finally {
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      }
    });
  }

  if (pathname === '/api/clipper/submissions' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT s.id, s.permalink, s.views, s.earning, s.status, s.sync_error, s.created_at, s.last_synced_at,
              s.last_ok_sync_at, s.locked_at, s.locked_earning, s.lock_reason,
              s.thumbnail_key, s.thumbnail_url, s.media_product_type, s.posted_at, s.source,
              s.platform, s.duration_seconds, s.is_short, s.eligible,
              c.name AS campaign_name, c.id AS campaign_id, c.cpm, c.min_views,
              a.username AS account_username,
              p.paid_at AS payment_paid_at
       FROM submissions s
       JOIN campaigns c ON c.id = s.campaign_id
       LEFT JOIN social_accounts a ON a.id = s.account_id
       LEFT JOIN payments p ON p.id = s.payment_id
       WHERE s.clipper_id = ? ORDER BY s.created_at DESC`
    ).bind(clipperId).all();

    return json({
      clips: (results || []).map(s => {
        const state = clipState(s);
        return {
          id: s.id,
          campaign_id: s.campaign_id,
          campaign_name: s.campaign_name,
          permalink: s.permalink,
          platform: s.platform || 'instagram',
          platform_label: platformLabel(s.platform || 'instagram'),
          account_username: s.account_username,
          duration_seconds: s.duration_seconds,
          is_short: s.is_short == null ? null : !!s.is_short,
          eligible: s.eligible !== 0,
          views: s.views,
          // A locked clip shows the amount that was actually settled, which is
          // frozen and will not move again however many views it gains.
          earning: s.locked_at ? (s.locked_earning || 0) : s.earning,
          cpm: s.cpm,
          min_views: s.min_views || 0,
          views_needed: Math.max(0, (s.min_views || 0) - s.views),
          state,
          state_message: clipStateMessage(state, s),
          locked: !!s.locked_at,
          locked_at: s.locked_at,
          lock_reason: s.lock_reason,
          paid_at: s.payment_paid_at,
          source: s.source || 'manual',
          has_thumb: !!(s.thumbnail_key || s.thumbnail_url),
          thumb: `/api/media/thumb/${s.id}`,
          created_at: s.created_at,
          posted_at: s.posted_at,
          last_synced_at: s.last_synced_at,
          last_ok_sync_at: s.last_ok_sync_at
        };
      })
    });
  }

  if (pathname === '/api/clipper/submissions' && method === 'POST') {
    const blocked = blockIfReadOnly();
    if (blocked) return blocked;
    const { campaign_id, url: postUrl, platform: askedPlatform } = await readJson(request);
    if (!campaign_id || !postUrl) return err('Pick a campaign and paste your post link');

    const campaign = await getCampaignById(env.DB, campaign_id);
    if (!campaign) return err('Campaign not found', 404);
    if (campaign.status === 'completed') return err('This campaign is over — it is no longer accepting new videos');
    if (campaign.status === 'budget_full') return err('This campaign\'s budget is fully allocated, so new videos can no longer earn');

    const part = await getParticipation(env.DB, clipperId, campaign_id);
    if (!part) return err('Join this campaign before submitting a video');
    if (part.status === 'kicked') return err('You have been removed from this campaign. Contact the ClipGrow admin.', 403);
    if (part.status === 'paused') return err('Your participation in this campaign is paused, so new videos cannot be submitted right now.', 403);

    // Work out which platform the link belongs to, so a clipper never has to
    // pick one from a dropdown and can't pick the wrong one.
    const allowed = campaignPlatforms(campaign);
    const platform = detectPlatform(postUrl, askedPlatform);
    if (!platform) return err('That link is not a recognised Instagram or YouTube link');
    if (!allowed.includes(platform)) {
      return err(`This campaign does not accept ${platformLabel(platform)} videos.`);
    }

    const account = await getParticipationAccount(env.DB, part.id, platform);
    if (!account) return err(`Connect the ${platformLabel(platform)} account for this campaign before submitting a video`);
    if (account.status === 'revoked') return err(`The ${platformLabel(platform)} account for this campaign is disconnected. Reconnect it to continue.`);
    if (account.status === 'needs_reauth') {
      return json({
        error: `The ${platformLabel(platform)} connection for this campaign has expired.`,
        fix: 'Click Reconnect on this campaign, then submit again.',
        code: 'TOKEN_EXPIRED', needs_reauth: true
      }, 400);
    }

    const adapter = getAdapter(platform);
    let media;
    try {
      // findByUrl proves the post belongs to the connected account, and for
      // YouTube also rejects anything that is not a Short.
      media = await adapter.withFreshToken(
        account, env,
        (token) => adapter.findByUrl({ ...account, access_token: token }, postUrl, env),
        async (fresh) => {
          await env.DB.prepare(
            `UPDATE social_accounts SET access_token = ?, refresh_token = COALESCE(?, refresh_token),
               token_expires_at = ? WHERE id = ?`
          ).bind(fresh.access_token, fresh.refresh_token || null, fresh.expires_at || null, account.id).run();
        }
      );
    } catch (e) {
      if (e && e.needsReauth) {
        await env.DB.prepare('UPDATE social_accounts SET status = ?, last_error_code = ?, last_error_at = ? WHERE id = ?')
          .bind('needs_reauth', e.code, now(), account.id).run();
      }
      return platformErrorResponse(e, 502);
    }

    const dup = await env.DB.prepare(
      'SELECT id, clipper_id FROM submissions WHERE platform = ? AND ig_media_id = ?'
    ).bind(platform, media.external_id).first();
    if (dup) {
      return err(dup.clipper_id === clipperId ? 'You have already submitted this video' : 'This video has already been submitted', 409);
    }

    // Best-effort preview capture; a missing image never blocks submission.
    const thumbSource = media.thumbnail_url || null;
    const thumbKey = await captureThumbnail(env, media.external_id, thumbSource);

    const res = await env.DB.prepare(
      `INSERT INTO submissions (clipper_id, campaign_id, account_id, platform, ig_media_id, permalink, views, earning,
         status, created_at, thumbnail_key, thumbnail_url, media_product_type, posted_at,
         duration_seconds, is_short, eligible)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      clipperId, campaign_id, account.id, platform, media.external_id, media.permalink, now(),
      thumbKey, thumbSource, media.media_type || null,
      media.posted_at || null,
      media.duration_seconds == null ? null : media.duration_seconds,
      media.is_short == null ? null : (media.is_short ? 1 : 0),
      media.eligible === false ? 0 : 1
    ).run();

    // Fetch this clipper's real view counts right now instead of waiting for
    // the next cron pass, so the number on screen is live the instant the
    // clip is added. Best-effort: a fresh Reel with insights not ready yet, or
    // a transient Instagram error, must never block the submission itself --
    // it just sits at 0 until the next sync (manual or 6-hourly) picks it up.
    let liveViews = 0, liveEarning = 0;
    try {
      await syncClipperViews(env.DB, clipperId, env);
      const fresh = await env.DB.prepare('SELECT views, earning FROM submissions WHERE id = ?')
        .bind(res.meta.last_row_id).first();
      if (fresh) { liveViews = fresh.views; liveEarning = fresh.earning; }
    } catch { /* falls back to 0 -- next sync will fill it in */ }

    return json({
      ok: true,
      message: liveViews > 0 ? `Clip verified and added — ${liveViews.toLocaleString('en-IN')} views so far` : 'Clip verified and added — views start tracking on the next sync',
      views: liveViews,
      earning: liveEarning
    }, 201);
  }

  // ------------------------------------------------------------ directory
  // Only active clippers, ranked by earnings. Totals only: no payment status,
  // no campaign breakdown, no individual clip links.
  if (pathname === '/api/clipper/directory' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT cl.id, cl.username, cl.display_name,
              COALESCE(SUM(s.views),0) AS views,
              COALESCE(SUM(s.earning),0) AS earned
       FROM clippers cl
       LEFT JOIN submissions s ON s.clipper_id = cl.id AND s.status = 'active'
       WHERE cl.status = 'active'
       GROUP BY cl.id
       ORDER BY earned DESC, views DESC, cl.display_name ASC`
    ).all();

    // Consistency streaks for the whole board in one query -- see
    // allClipperStreaks. Measured on when clips were POSTED, not when they
    // were imported, so a slow import can never cost someone their streak.
    const streaks = await allClipperStreaks(env.DB);

    return json({
      clippers: (results || []).map((c, i) => {
        const s = streaks.get(c.id) || { current: 0, best: 0, last_post_at: null, days_since_last_post: null };
        return {
          id: c.id,
          rank: i + 1,
          display_name: c.display_name || c.username,
          views: c.views,
          earned: c.earned,
          streak: s.current,
          best_streak: s.best,
          last_post_at: s.last_post_at,
          days_since_last_post: s.days_since_last_post,
          is_me: c.id === clipperId
        };
      })
    });
  }

  return null;
}
