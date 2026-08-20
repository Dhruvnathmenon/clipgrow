// YouTube Data API v3 integration.
//
// Deliberately mirrors src/instagram.js in shape and error vocabulary so a
// YouTube failure explains itself to a clipper as clearly as an Instagram one.
//
// Two things differ fundamentally from Instagram and drive the design here:
//
//  1. TOKENS. Instagram issues a single long-lived token that refreshes itself.
//     Google issues a short access token (about an hour) plus a refresh token
//     that is returned ONLY on the first consent unless prompt=consent is
//     forced. Losing it means tracking silently dies an hour later, so a
//     connection without a refresh token is rejected outright.
//
//  2. QUOTA. The project gets 10,000 units/day. videos.list costs 1 unit for
//     up to 50 ids in a single call, so view fetching is batched 50 at a time.
//     Instagram costs one call per clip; YouTube costs one call per fifty.

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/youtube/v3';

const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

// videos.list accepts up to 50 ids per request, and each request is 1 unit.
export const VIEW_BATCH_SIZE = 50;

// Generous ceiling for "could plausibly be a Short". Only used to skip the
// Shorts probe on obviously long videos; the probe itself is authoritative, so
// this never has to track YouTube's actual Shorts length limit.
const SHORT_CANDIDATE_MAX_SECONDS = 300;

export class YtError extends Error {
  constructor(code, message, fix, { retryable = false, needsReauth = false, status = 0 } = {}) {
    super(message);
    this.name = 'YtError';
    this.code = code;
    this.fix = fix;
    this.retryable = retryable;
    this.needsReauth = needsReauth;
    this.status = status;
  }
  toJSON() {
    return { code: this.code, message: this.message, fix: this.fix, needs_reauth: this.needsReauth };
  }
}

export const YT_ERRORS = {
  NOT_CONFIGURED: () => new YtError(
    'NOT_CONFIGURED',
    'YouTube connection is not switched on yet.',
    'The ClipGrow admin still needs to finish the Google app setup. Nothing you can fix from here.'
  ),
  NO_REFRESH_TOKEN: () => new YtError(
    'NO_REFRESH_TOKEN',
    'Google did not return a long-term permission for this channel, so view tracking would stop within the hour.',
    'Connect again and make sure you approve access on the Google screen rather than dismissing it. If Google skips the approval screen, remove ClipGrow at myaccount.google.com/permissions first, then retry.'
  ),
  TOKEN_EXPIRED: () => new YtError(
    'TOKEN_EXPIRED',
    'The connection to this YouTube channel has expired.',
    'Click Reconnect on this campaign to re-authorise the channel. Nothing you have already earned is affected.',
    { needsReauth: true }
  ),
  TOKEN_REVOKED: () => new YtError(
    'TOKEN_REVOKED',
    'Access to this YouTube channel was removed — ClipGrow was revoked in your Google account settings.',
    'Click Reconnect and approve access again. Nothing you have already earned is affected.',
    { needsReauth: true }
  ),
  NOT_A_TESTER: () => new YtError(
    'NOT_A_TESTER',
    'This Google account has not been given access to the ClipGrow app yet.',
    'Send the Gmail address of your YouTube channel to the ClipGrow admin, wait until they confirm it has been added, then connect again.'
  ),
  NO_CHANNEL: () => new YtError(
    'NO_CHANNEL',
    'That Google account does not have a YouTube channel.',
    'Sign in with the Google account that actually owns your channel, or create a channel on YouTube first, then connect again.'
  ),
  QUOTA: () => new YtError(
    'QUOTA',
    'YouTube is temporarily rate-limiting requests.',
    'Nothing to do — views will update automatically on the next sync.',
    { retryable: true }
  ),
  MEDIA_NOT_FOUND: () => new YtError(
    'MEDIA_NOT_FOUND',
    "That video couldn't be found on the YouTube channel connected to this campaign.",
    'Check the link is from the same channel you connected, that the video is public, and that it has not been deleted.'
  ),
  NOT_SHORT: () => new YtError(
    'NOT_SHORT',
    'This campaign pays on YouTube Shorts, and that link points to a regular upload.',
    'Post the clip as a Short (vertical, under the Shorts length limit) and submit that link instead.'
  ),
  NETWORK: () => new YtError(
    'NETWORK',
    "Couldn't reach YouTube just now.",
    'This is usually temporary — try again in a minute.',
    { retryable: true }
  ),
  UNKNOWN: (msg) => new YtError('UNKNOWN', msg || 'Something went wrong talking to YouTube.',
    'Try again — if it keeps happening, tell the ClipGrow admin.', { retryable: true })
};

function classify(status, body) {
  const e = (body && body.error) || {};
  const msg = e.message || (body && body.error_description) || '';
  const reason = (e.errors && e.errors[0] && e.errors[0].reason) || (body && body.error) || '';

  if (status === 401 || /invalid_grant|invalid credentials|token expired/i.test(String(reason) + msg)) {
    if (/revoked|invalid_grant/i.test(String(reason) + msg)) return YT_ERRORS.TOKEN_REVOKED();
    return YT_ERRORS.TOKEN_EXPIRED();
  }
  if (status === 403) {
    if (/quotaExceeded|rateLimitExceeded|userRateLimitExceeded/i.test(String(reason))) return YT_ERRORS.QUOTA();
    if (/accessNotConfigured|forbidden/i.test(String(reason))) {
      return new YtError('API_DISABLED', 'The YouTube Data API is not enabled for the ClipGrow app.',
        'The ClipGrow admin needs to enable YouTube Data API v3 in the Google Cloud project.');
    }
    return YT_ERRORS.TOKEN_REVOKED();
  }
  if (status === 404) return YT_ERRORS.MEDIA_NOT_FOUND();
  if (status === 429) return YT_ERRORS.QUOTA();
  if (status >= 500) return YT_ERRORS.NETWORK();
  return YT_ERRORS.UNKNOWN(msg);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function ytFetch(url, { headers = {}, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers });
    } catch {
      lastErr = YT_ERRORS.NETWORK();
      await sleep(300 * Math.pow(2, attempt));
      continue;
    }
    const payload = await res.json().catch(() => null);
    if (res.ok) return payload;

    const err = classify(res.status, payload);
    lastErr = err;
    if (!err.retryable || attempt === retries) throw err;
    await sleep(500 * Math.pow(2, attempt));
  }
  throw lastErr || YT_ERRORS.UNKNOWN();
}

// ------------------------------------------------------------------- OAuth

export function getAuthorizeUrl(env, redirectUri, state) {
  const q = new URLSearchParams({
    client_id: env.YT_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    // access_type=offline is what makes Google issue a refresh token at all,
    // and prompt=consent forces it to be re-issued on every reconnect. Without
    // the latter, Google silently omits it on a second authorisation and the
    // connection dies as soon as the one-hour access token lapses.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state
  });
  return `${AUTH_URL}?${q.toString()}`;
}

async function postToken(form) {
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form
    });
  } catch {
    throw YT_ERRORS.NETWORK();
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (payload && (payload.error_description || payload.error)) || '';
    if (/access_denied|admin_policy|not been granted|test user/i.test(String(msg))) throw YT_ERRORS.NOT_A_TESTER();
    console.error('YT token exchange failed', res.status, JSON.stringify(payload));
    throw classify(res.status, payload);
  }
  return payload;
}

export async function exchangeCodeForToken(env, code, redirectUri) {
  const form = new URLSearchParams({
    client_id: env.YT_CLIENT_ID,
    client_secret: env.YT_CLIENT_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code
  });
  const r = await postToken(form);
  // Without this the account would appear to connect fine and then stop
  // updating an hour later, which is far worse than refusing up front.
  if (!r.refresh_token) throw YT_ERRORS.NO_REFRESH_TOKEN();
  return {
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expires_at: Date.now() + (Number(r.expires_in) || 3600) * 1000
  };
}

export async function refreshAccessToken(account, env) {
  if (!account.refresh_token) throw YT_ERRORS.NO_REFRESH_TOKEN();
  const form = new URLSearchParams({
    client_id: env.YT_CLIENT_ID,
    client_secret: env.YT_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: account.refresh_token
  });
  const r = await postToken(form);
  return {
    access_token: r.access_token,
    // Google usually omits refresh_token on refresh; keeping the existing one
    // is correct, and it only rotates if a new one is actually returned.
    refresh_token: r.refresh_token || account.refresh_token,
    expires_at: Date.now() + (Number(r.expires_in) || 3600) * 1000
  };
}

/**
 * Runs a call with the account's access token, transparently refreshing once
 * if the token has expired. Google's access tokens last about an hour, so
 * mid-sync expiry is normal rather than exceptional and must not surface as a
 * failed clip.
 *
 * @param onRefresh called with the new credentials so the caller can persist them
 */
export async function withFreshToken(account, env, fn, onRefresh) {
  let token = account.access_token;
  const expired = !account.token_expires_at || account.token_expires_at < Date.now() + 60000;

  if (expired) {
    const fresh = await refreshAccessToken(account, env);
    token = fresh.access_token;
    if (onRefresh) await onRefresh(fresh);
  }

  try {
    return await fn(token);
  } catch (e) {
    if (e instanceof YtError && (e.code === 'TOKEN_EXPIRED') && !expired) {
      const fresh = await refreshAccessToken(account, env);
      if (onRefresh) await onRefresh(fresh);
      return await fn(fresh.access_token);
    }
    throw e;
  }
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

// ----------------------------------------------------------------- channel

/** The signed-in user's channel, plus the uploads playlist that lists it. */
export async function fetchChannel(accessToken) {
  const url = new URL(`${API_BASE}/channels`);
  url.searchParams.set('part', 'snippet,contentDetails');
  url.searchParams.set('mine', 'true');
  const body = await ytFetch(url.toString(), { headers: auth(accessToken) });
  const ch = (body.items || [])[0];
  if (!ch) throw YT_ERRORS.NO_CHANNEL();
  return {
    id: ch.id,
    username: (ch.snippet && (ch.snippet.customUrl || ch.snippet.title)) || ch.id,
    title: (ch.snippet && ch.snippet.title) || '',
    uploads_playlist: ch.contentDetails && ch.contentDetails.relatedPlaylists
      ? ch.contentDetails.relatedPlaylists.uploads : null
  };
}

// ------------------------------------------------------------------ shorts

/**
 * Whether a video is a Short.
 *
 * The Data API exposes no Shorts flag, so this probes the /shorts/ URL, which
 * is authoritative: YouTube serves a Short at that path (200) and redirects a
 * regular upload to /watch (303). Verified empirically rather than inferred
 * from duration, so it stays correct if YouTube changes the length limit.
 *
 * Costs no API quota -- it is a plain request to youtube.com, not the API.
 * Returns null when the answer cannot be established, so an unreachable probe
 * is never mistaken for "not a Short".
 */
export async function isShortVideo(videoId, durationSeconds) {
  if (durationSeconds != null && durationSeconds > SHORT_CANDIDATE_MAX_SECONDS) return false;
  try {
    const res = await fetch(`https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`, {
      method: 'HEAD',
      redirect: 'manual'
    });
    if (res.status === 200) return true;
    if (res.status >= 300 && res.status < 400) return false;
    return null;
  } catch {
    return null;
  }
}

/** ISO-8601 duration (PT1M30S) to seconds. */
export function parseDuration(iso) {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(String(iso));
  if (!m) return null;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) +
         (Number(m[3] || 0) * 60) + Math.floor(Number(m[4] || 0));
}

export function normaliseVideo(v) {
  const duration = parseDuration(v.contentDetails && v.contentDetails.duration);
  const sn = v.snippet || {};
  const thumbs = sn.thumbnails || {};
  const thumb = thumbs.maxres || thumbs.standard || thumbs.high || thumbs.medium || thumbs.default;
  return {
    external_id: v.id,
    permalink: `https://www.youtube.com/shorts/${v.id}`,
    thumbnail_url: thumb ? thumb.url : null,
    posted_at: sn.publishedAt ? Date.parse(sn.publishedAt) || null : null,
    media_type: 'youtube_video',
    duration_seconds: duration,
    is_short: v.__is_short == null ? null : v.__is_short,
    // Set by the caller once the Shorts probe has run.
    eligible: v.__is_short === true,
    ineligible_reason: v.__is_short === true ? null : 'not_a_short'
  };
}

// ------------------------------------------------------------------ videos

/**
 * Hydrates video ids with snippet/statistics/contentDetails, 50 per call.
 *
 * Each batch of 50 is isolated: if one batch's request fails, that failure is
 * recorded only against the ids in that batch, and the loop still attempts
 * every remaining batch. A channel with, say, 120 clips makes three calls
 * here -- without this, one of those three failing (a transient blip) would
 * discard the other two batches' results as well and mark all 120 clips with
 * the same error, which is the exact bug this mirrors on the Instagram side.
 */
// `fetchOneBatch` is injectable so tests can prove the per-batch isolation
// below without mocking the network. Production always uses the default.
export async function fetchVideoDetails(ids, accessToken, apiKey, fetchOneBatch = ytFetch) {
  const out = [];
  for (let i = 0; i < ids.length; i += VIEW_BATCH_SIZE) {
    const batch = ids.slice(i, i + VIEW_BATCH_SIZE);
    const url = new URL(`${API_BASE}/videos`);
    url.searchParams.set('part', 'snippet,statistics,contentDetails,status');
    url.searchParams.set('id', batch.join(','));
    // An API key works for public videos and costs no clipper token, so view
    // reads keep working even while a channel's OAuth needs re-authorising.
    const headers = {};
    if (apiKey) url.searchParams.set('key', apiKey);
    else Object.assign(headers, auth(accessToken));
    try {
      const body = await fetchOneBatch(url.toString(), { headers });
      out.push(...(body.items || []));
    } catch (e) {
      for (const id of batch) out.push({ id, __batchError: (e && e.code) || 'UNKNOWN' });
    }
  }
  return out;
}

/**
 * View counts for a set of video ids.
 * @returns Map(videoId -> {ok:true, views} | {ok:false, code}). An id missing
 *          from the map entirely means it was genuinely absent from a
 *          successful response -- the honest signal that the video is gone.
 *          An id present with ok:false means the fetch itself failed for
 *          just that id's batch, which the caller must not confuse with the
 *          video not existing.
 */
export async function fetchViews(account, mediaIds, env) {
  const items = await fetchVideoDetails(mediaIds, account.access_token, env && env.YT_API_KEY);
  const map = new Map();
  for (const v of items) {
    if (v.__batchError) { map.set(v.id, { ok: false, code: v.__batchError }); continue; }
    const n = v.statistics && v.statistics.viewCount;
    map.set(v.id, { ok: true, views: Number(n || 0) || 0 });
  }
  return map;
}

/**
 * Videos published strictly after `sinceTs`, newest first.
 *
 * The floor is what stops a clipper connecting a channel with an old viral
 * video and instantly claiming a campaign's budget -- the same guardrail
 * Instagram auto-import uses.
 */
export async function listRecent(account, { sinceTs = 0, maxPages = 3, knownIds = null } = {}, env) {
  const meta = account.meta_json ? JSON.parse(account.meta_json) : {};
  const playlist = meta.uploads_playlist;
  if (!playlist) return [];

  const ids = [];
  let pageToken = '';
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${API_BASE}/playlistItems`);
    url.searchParams.set('part', 'contentDetails');
    url.searchParams.set('playlistId', playlist);
    url.searchParams.set('maxResults', '50');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const body = await ytFetch(url.toString(), { headers: auth(account.access_token) });

    let hitOld = false;
    for (const item of body.items || []) {
      const cd = item.contentDetails || {};
      const ts = cd.videoPublishedAt ? Date.parse(cd.videoPublishedAt) : 0;
      if (ts && ts <= sinceTs) { hitOld = true; continue; }
      if (cd.videoId) ids.push(cd.videoId);
    }
    if (hitOld) break;
    pageToken = body.nextPageToken || '';
    if (!pageToken) break;
  }
  if (!ids.length) return [];

  // Drop anything already recorded BEFORE the expensive work below.
  //
  // This matters far more than it looks. `sinceTs` is connected_at, so this
  // function returns EVERY video posted since the channel was connected --
  // a set that only grows. Each one then costs an isShortVideo() probe, which
  // is a separate external HTTP request per video. The caller used to dedup
  // afterwards, so a channel with 27 videos since connect burned 27 probes on
  // every single run to import maybe one new clip, and a Worker invocation has
  // a hard per-invocation subrequest ceiling shared with everything else the
  // sync does. Past a certain channel size the import simply stops fitting.
  const fresh = knownIds ? ids.filter(id => !knownIds.has(String(id))) : ids;
  if (!fresh.length) return [];

  const items = await fetchVideoDetails(fresh, account.access_token, env && env.YT_API_KEY);
  const out = [];
  for (const v of items) {
    if (v.status && v.status.privacyStatus && v.status.privacyStatus !== 'public') continue;
    const duration = parseDuration(v.contentDetails && v.contentDetails.duration);
    v.__is_short = await isShortVideo(v.id, duration);
    out.push(normaliseVideo(v));
  }
  return out;
}

const ID_PATTERNS = [
  /youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/i,
  /youtube\.com\/watch\?[^#]*\bv=([A-Za-z0-9_-]{6,})/i,
  /youtu\.be\/([A-Za-z0-9_-]{6,})/i,
  /youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/i
];

export function extractVideoId(url) {
  const s = String(url || '').trim();
  for (const re of ID_PATTERNS) {
    const m = re.exec(s);
    if (m) return m[1];
  }
  // A bare id pasted on its own.
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  return null;
}

/** Resolves a pasted link, proving the video belongs to the connected channel. */
export async function findByUrl(account, url, env) {
  const id = extractVideoId(url);
  if (!id) throw YT_ERRORS.MEDIA_NOT_FOUND();

  const items = await fetchVideoDetails([id], account.access_token, env && env.YT_API_KEY);
  const v = items[0];
  if (!v) throw YT_ERRORS.MEDIA_NOT_FOUND();

  // Ownership check: the video's channel must be the connected channel,
  // otherwise a clipper could claim someone else's viral Short.
  const owner = v.snippet && v.snippet.channelId;
  if (!owner || owner !== account.external_id) throw YT_ERRORS.MEDIA_NOT_FOUND();

  const duration = parseDuration(v.contentDetails && v.contentDetails.duration);
  v.__is_short = await isShortVideo(v.id, duration);
  if (v.__is_short !== true) throw YT_ERRORS.NOT_SHORT();

  return normaliseVideo(v);
}
