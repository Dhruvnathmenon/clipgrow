const AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
const TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const GRAPH_BASE = 'https://graph.instagram.com';

// Scopes for "Instagram API with Instagram Login". Must match the permissions
// enabled on the app's Instagram product page -- Meta's own generated embed URL
// requests exactly these five, so we mirror it to avoid any grant mismatch.
// Override with the IG_SCOPES var if the app's permission set changes.
const DEFAULT_SCOPES = 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments,instagram_business_content_publish,instagram_business_manage_insights';

// Instagram accounts must be Professional to expose insights at all.
const PROFESSIONAL_TYPES = new Set(['BUSINESS', 'MEDIA_CREATOR', 'CREATOR']);

/**
 * A failure we can explain to a clipper in plain language, with the exact fix.
 * `retryable` marks transient issues the sync should back off on rather than
 * flagging the account as broken.
 */
export class IgError extends Error {
  constructor(code, message, fix, { retryable = false, needsReauth = false, status = 0 } = {}) {
    super(message);
    this.name = 'IgError';
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

export const IG_ERRORS = {
  NOT_PROFESSIONAL: (type) => new IgError(
    'NOT_PROFESSIONAL',
    `That Instagram account is a ${type === 'PERSONAL' ? 'Personal' : type || 'non-professional'} account, so Instagram won't share view counts for it.`,
    'Open Instagram → Settings → Account type and tools → Switch to professional account → pick Creator or Business. Then come back and connect again.'
  ),
  TOKEN_EXPIRED: () => new IgError(
    'TOKEN_EXPIRED',
    'The connection to this Instagram account has expired.',
    'Click Reconnect on this campaign to re-authorise the account. Nothing you have already earned is affected.',
    { needsReauth: true }
  ),
  TOKEN_REVOKED: () => new IgError(
    'TOKEN_REVOKED',
    'Access to this Instagram account was removed — either the password changed, or ClipGrow was revoked in Instagram settings.',
    'Click Reconnect and approve access again. Nothing you have already earned is affected.',
    { needsReauth: true }
  ),
  PERMISSION_MISSING: () => new IgError(
    'PERMISSION_MISSING',
    'This connection is missing the permission needed to read view counts.',
    'Reconnect the account and make sure you leave every permission checkbox ticked on the Instagram approval screen.',
    { needsReauth: true }
  ),
  NOT_A_TESTER: () => new IgError(
    'NOT_A_TESTER',
    'This Instagram account has not been given access to the ClipGrow app yet.',
    'Send your Instagram handle to the ClipGrow admin, accept the tester invite in Instagram → Settings → Apps and websites → Tester invites, then connect again.'
  ),
  RATE_LIMITED: () => new IgError(
    'RATE_LIMITED',
    'Instagram is temporarily rate-limiting requests.',
    'Nothing to do — views will update automatically on the next sync.',
    { retryable: true }
  ),
  MEDIA_NOT_FOUND: () => new IgError(
    'MEDIA_NOT_FOUND',
    "That post couldn't be found on the Instagram account connected to this campaign.",
    'Check the link is from the same account you connected for this campaign, that the post is public, and that it has not been deleted.'
  ),
  NOT_VIDEO: () => new IgError(
    'NOT_VIDEO',
    'Only Reels and video posts earn on views — that link points to a photo or carousel.',
    'Submit the link to a Reel instead.'
  ),
  INSIGHTS_UNAVAILABLE: () => new IgError(
    'INSIGHTS_UNAVAILABLE',
    'Instagram is not reporting view counts for this post yet.',
    'Brand-new posts can take a few hours before insights appear. It will pick up on the next sync automatically.',
    { retryable: true }
  ),
  NETWORK: () => new IgError(
    'NETWORK',
    "Couldn't reach Instagram just now.",
    'This is usually temporary — try again in a minute.',
    { retryable: true }
  ),
  UNKNOWN: (msg) => new IgError('UNKNOWN', msg || 'Something went wrong talking to Instagram.', 'Try again — if it keeps happening, tell the ClipGrow admin.', { retryable: true })
};

// Maps a Meta error payload onto one of our typed errors.
//
// Two different shapes exist. The Graph API (graph.instagram.com) nests details
// under `error: { message, code, error_subcode }`. The OAuth token endpoint
// (api.instagram.com/oauth/access_token) instead returns them at the top level
// as `error_type` / `code` / `error_message`. Reading only the Graph shape made
// every token-exchange failure collapse into a blank UNKNOWN, hiding the real
// reason (bad client secret, redirect_uri mismatch, reused code, ...).
function classify(status, body) {
  const e = (body && body.error) || {};
  const code = e.code != null ? e.code : (body && body.code);
  const sub = e.error_subcode;
  const msg = e.message || (body && (body.error_message || body.error_description)) || '';
  const type = (body && body.error_type) || '';

  // OAuth token-endpoint failures only carry a message/type, no numeric Graph
  // code -- surface that message verbatim so it is actually diagnosable.
  if (!e.code && (body && (body.error_message || body.error_type))) {
    if (/tester|development mode|not been granted|does not have access/i.test(msg)) return IG_ERRORS.NOT_A_TESTER();
    if (/redirect_uri|redirect uri/i.test(msg)) {
      return new IgError('REDIRECT_MISMATCH', 'Instagram rejected the connection: ' + msg,
        'The ClipGrow admin needs to confirm the redirect URL in the Meta app matches https://clipgrow.in/api/auth/instagram/callback exactly.');
    }
    if (/client_secret|client secret|invalid client|invalid_client/i.test(msg)) {
      return new IgError('BAD_SECRET', 'Instagram rejected the app credentials.',
        'The ClipGrow admin needs to re-check the Instagram App Secret saved in the Worker settings.');
    }
    return IG_ERRORS.UNKNOWN(type ? `${type}: ${msg}` : msg);
  }

  if (code === 4 || code === 17 || code === 32 || code === 613 || status === 429) return IG_ERRORS.RATE_LIMITED();
  if (code === 190) {
    if (sub === 458 || sub === 459 || sub === 460 || /revoke/i.test(msg)) return IG_ERRORS.TOKEN_REVOKED();
    return IG_ERRORS.TOKEN_EXPIRED();
  }
  if (code === 10 || code === 200 || code === 803) {
    if (/tester|development mode|not been granted/i.test(msg)) return IG_ERRORS.NOT_A_TESTER();
    return IG_ERRORS.PERMISSION_MISSING();
  }
  if (code === 100) {
    if (/does not exist|cannot be loaded|unsupported get request/i.test(msg)) return IG_ERRORS.MEDIA_NOT_FOUND();
    if (/metric/i.test(msg)) return IG_ERRORS.INSIGHTS_UNAVAILABLE();
    return IG_ERRORS.PERMISSION_MISSING();
  }
  if (status >= 500) return IG_ERRORS.NETWORK();
  return IG_ERRORS.UNKNOWN(msg);
}

// `onAttempt` fires once per real outbound request to Instagram, including
// retries -- Instagram's rate limit counts every attempt, successful or not.
// This is how every function below reports its usage to the caller's budget
// tracker without instagram.js needing to know D1 or the app's schema exist;
// it stays a plain API client. Callers that don't care (token exchange during
// login, for instance) simply omit it.
async function igFetch(url, { method = 'GET', body, retries = 2, onAttempt } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    if (onAttempt) onAttempt();
    try {
      res = await fetch(url, { method, body });
    } catch {
      lastErr = IG_ERRORS.NETWORK();
      await sleep(300 * Math.pow(2, attempt));
      continue;
    }

    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }

    if (res.ok) return payload;

    const err = classify(res.status, payload);
    lastErr = err;
    // Only transient classes are worth another attempt.
    if (!err.retryable || attempt === retries) throw err;
    await sleep(500 * Math.pow(2, attempt));
  }
  throw lastErr || IG_ERRORS.UNKNOWN();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function getAuthorizeUrl(env, redirectUri, state) {
  // Byte-match Meta's own generated embed URL: redirect_uri is sent RAW
  // (NOT percent-encoded). Instagram binds the auth code to the redirect_uri
  // string exactly as received here; the token exchange then sends the same raw
  // value. (URLSearchParams percent-encodes it, which made Instagram bind to
  // the encoded form and reject the token exchange -- verified via the /_try
  // probe: both slash and no-slash decoded forms were rejected.)
  const scope = env.IG_SCOPES || DEFAULT_SCOPES;
  const q =
    'force_reauth=true' +
    '&client_id=' + env.IG_CLIENT_ID +
    '&redirect_uri=' + redirectUri +
    '&response_type=code' +
    '&scope=' + encodeURIComponent(scope) +
    '&state=' + encodeURIComponent(state);
  return AUTHORIZE_URL + '?' + q;
}

async function postTokenExchange(env, code, redirectUri) {
  const form = new URLSearchParams();
  form.set('client_id', env.IG_CLIENT_ID);
  form.set('client_secret', env.IG_CLIENT_SECRET);
  form.set('grant_type', 'authorization_code');
  form.set('redirect_uri', redirectUri);
  form.set('code', code);
  let res;
  try {
    res = await fetch(TOKEN_URL, { method: 'POST', body: form });
  } catch {
    throw IG_ERRORS.NETWORK();
  }
  const payload = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, payload };
}

export async function exchangeCodeForToken(env, code, redirectUri) {
  // Instagram validates redirect_uri against the REGISTERED value, which the
  // App Dashboard may silently store with a trailing slash. A failed exchange
  // does not consume the code, so if the exact URI is rejected we retry the
  // same code with the slash toggled -- whichever form was registered wins.
  const withSlash = redirectUri.endsWith('/') ? redirectUri : redirectUri + '/';
  const withoutSlash = redirectUri.replace(/\/+$/, '');
  const variants = [redirectUri, redirectUri === withoutSlash ? withSlash : withoutSlash];

  let last = null;
  for (const variant of variants) {
    const r = await postTokenExchange(env, code, variant);
    if (r.ok) {
      console.log('IG token exchange OK with redirect_uri=[' + variant + ']');
      return r.payload;
    }
    console.error('IG token exchange failed', r.status, 'redirect_uri=[' + variant + ']', JSON.stringify(r.payload));
    last = r;
    // Only worth retrying the other variant on a redirect_uri complaint.
    const msg = (r.payload && (r.payload.error_message || (r.payload.error && r.payload.error.message))) || '';
    if (!/redirect_uri/i.test(msg)) break;
  }
  throw classify(last.status, last.payload);
}

export async function exchangeForLongLivedToken(env, shortToken) {
  const url = new URL(`${GRAPH_BASE}/access_token`);
  url.searchParams.set('grant_type', 'ig_exchange_token');
  url.searchParams.set('client_secret', env.IG_CLIENT_SECRET);
  url.searchParams.set('access_token', shortToken);
  return igFetch(url.toString());
}

export async function refreshLongLivedToken(accessToken) {
  const url = new URL(`${GRAPH_BASE}/refresh_access_token`);
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', accessToken);
  return igFetch(url.toString());
}

/** Fetches the profile and rejects non-professional accounts up front. */
export async function fetchProfile(accessToken) {
  const url = new URL(`${GRAPH_BASE}/me`);
  url.searchParams.set('fields', 'user_id,username,account_type');
  url.searchParams.set('access_token', accessToken);
  const me = await igFetch(url.toString());

  const type = (me.account_type || '').toUpperCase();
  // Some app configurations omit account_type; only reject when we positively
  // know it is a personal account.
  if (type && !PROFESSIONAL_TYPES.has(type)) throw IG_ERRORS.NOT_PROFESSIONAL(type);

  return {
    id: String(me.user_id || me.id),
    username: me.username || '',
    account_type: type || ''
  };
}

function normalizePermalink(u) {
  try {
    const url = new URL(String(u).trim());
    return (url.origin + url.pathname).replace(/\/+$/, '').toLowerCase();
  } catch {
    return String(u).trim().replace(/\/+$/, '').toLowerCase();
  }
}

/** Finds a post on the connected account by its public permalink. */
export async function findMediaByUrl(igUserId, accessToken, permalinkUrl, { onAttempt } = {}) {
  const target = normalizePermalink(permalinkUrl);
  let url = new URL(`${GRAPH_BASE}/${igUserId}/media`);
  url.searchParams.set('fields', 'id,permalink,media_type,media_product_type,timestamp,thumbnail_url,media_url,caption');
  url.searchParams.set('limit', '100');
  url.searchParams.set('access_token', accessToken);

  for (let page = 0; page < 10; page++) {
    const body = await igFetch(url.toString(), { onAttempt });
    const match = (body.data || []).find(m => m.permalink && normalizePermalink(m.permalink) === target);
    if (match) return match;
    const next = body.paging && body.paging.next;
    if (!next) break;
    url = new URL(next);
  }
  return null;
}

/**
 * Lists an account's media newest-first, stopping as soon as it reaches
 * anything posted at or before `sinceTs`.
 *
 * Backs auto-import. The `sinceTs` floor is what stops a clipper connecting an
 * account with an old viral Reel and instantly claiming the whole budget --
 * only genuinely new posts are picked up automatically.
 */
export async function listRecentMedia(igUserId, accessToken, { sinceTs = 0, maxPages = 3, onAttempt } = {}) {
  let url = new URL(`${GRAPH_BASE}/${igUserId}/media`);
  url.searchParams.set('fields', 'id,permalink,media_type,media_product_type,timestamp,thumbnail_url,media_url');
  url.searchParams.set('limit', '50');
  url.searchParams.set('access_token', accessToken);

  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const body = await igFetch(url.toString(), { onAttempt });
    const items = (body && body.data) || [];
    let hitOld = false;
    for (const m of items) {
      const ts = m.timestamp ? Date.parse(m.timestamp) : 0;
      if (ts && ts <= sinceTs) { hitOld = true; continue; }
      out.push(m);
    }
    // Results are newest-first, so the first old item means we're done.
    if (hitOld) break;
    const next = body && body.paging && body.paging.next;
    if (!next) break;
    url = new URL(next);
  }
  return out;
}

export function isVideoMedia(media) {
  const type = (media.media_type || '').toUpperCase();
  const product = (media.media_product_type || '').toUpperCase();
  return type === 'VIDEO' || product === 'REELS';
}

// Meta has shuffled view metrics over time; `views` is current, the rest are
// fallbacks for older media so a metric rename doesn't zero everyone's earnings.
const VIEW_METRICS = ['views', 'plays', 'video_views', 'impressions'];

export async function fetchMediaViews(mediaId, accessToken, { onAttempt } = {}) {
  let lastErr;
  for (const metric of VIEW_METRICS) {
    const url = new URL(`${GRAPH_BASE}/${mediaId}/insights`);
    url.searchParams.set('metric', metric);
    url.searchParams.set('access_token', accessToken);
    try {
      const body = await igFetch(url.toString(), { retries: 1, onAttempt });
      const row = (body.data || []).find(d => d.name === metric);
      const value = row && row.values && row.values[0] ? row.values[0].value : null;
      if (value != null) return Number(value) || 0;
    } catch (e) {
      lastErr = e;
      // An unsupported metric is worth trying the next name; anything else is real.
      if (e.code !== 'INSIGHTS_UNAVAILABLE' && e.code !== 'UNKNOWN') throw e;
    }
  }
  throw lastErr || IG_ERRORS.INSIGHTS_UNAVAILABLE();
}

// ---------------------------------------------------------------- diagnostics
// Not part of the normal sync path (that path deliberately stops at the first
// metric that answers, so it spends exactly one call per clip against the
// 200/hour budget). These exist to diagnose a genuine disagreement between
// what the Graph API reports and what the Instagram app displays, from real
// data rather than guesswork. Every call here is counted against the account's
// budget like any other -- a diagnostic that quietly spent untracked quota
// would corrupt the very ledger it is being used to investigate.

const DIAGNOSTIC_METRICS = [
  'views', 'reach', 'total_interactions', 'likes', 'saved', 'shares',
  // Reels-only. crossposted_views / facebook_views matter because a reel also
  // shared to Facebook accrues views on a surface plain `views` may exclude.
  'crossposted_views', 'facebook_views',
  'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time', 'reels_skip_rate'
];

// like_count/comments_count are the discriminator: if those match what the app
// shows while `views` does not, the media object itself is current and only
// the insights aggregation has diverged. If they are ALSO stale/tiny, we are
// reading a different object than the one on screen.
const MEDIA_FIELDS_FULL = 'id,caption,media_type,media_product_type,permalink,timestamp,username,like_count,comments_count,is_shared_to_feed';
const MEDIA_FIELDS_MIN = 'id,media_type,media_product_type,permalink,timestamp';

export async function debugMediaInsights(mediaId, accessToken, { onAttempt } = {}) {
  const out = { media_id: mediaId, media: null, metrics: [] };

  // Fall back to a minimal field set if any single field is rejected, so one
  // unsupported field cannot blank out the whole media lookup.
  for (const fields of [MEDIA_FIELDS_FULL, MEDIA_FIELDS_MIN]) {
    const mediaUrl = new URL(`${GRAPH_BASE}/${mediaId}`);
    mediaUrl.searchParams.set('fields', fields);
    mediaUrl.searchParams.set('access_token', accessToken);
    try {
      out.media = await igFetch(mediaUrl.toString(), { retries: 0, onAttempt });
      break;
    } catch (e) {
      out.media = { error: e.code || 'UNKNOWN', message: e.message, fields_tried: fields };
    }
  }

  for (const metric of DIAGNOSTIC_METRICS) {
    const url = new URL(`${GRAPH_BASE}/${mediaId}/insights`);
    url.searchParams.set('metric', metric);
    url.searchParams.set('access_token', accessToken);
    try {
      const body = await igFetch(url.toString(), { retries: 0, onAttempt });
      const row = (body.data || []).find(d => d.name === metric);
      out.metrics.push({
        metric,
        ok: true,
        value: row && row.values && row.values[0] ? row.values[0].value : null,
        title: row ? row.title : null
      });
    } catch (e) {
      out.metrics.push({ metric, ok: false, code: e.code, message: e.message });
    }
  }

  return out;
}

/**
 * Lists the account's own recent media with identifying fields. The point is
 * to detect the case where one permalink is backed by MORE THAN ONE media id
 * -- which is what a co-authored ("collab") reel looks like from the API's
 * side: each participating account holds its own media object for the single
 * shared post, and those objects do not necessarily report the same insights.
 * If that is what is happening, we may simply be holding the wrong one of the
 * two ids for this clip.
 */
export async function debugListMedia(igUserId, accessToken, { maxPages = 2, onAttempt } = {}) {
  const items = [];
  let url = new URL(`${GRAPH_BASE}/${igUserId}/media`);
  url.searchParams.set('fields', 'id,permalink,media_product_type,timestamp,like_count,comments_count,username');
  url.searchParams.set('limit', '50');
  url.searchParams.set('access_token', accessToken);

  for (let page = 0; page < maxPages && url; page++) {
    const body = await igFetch(url.toString(), { retries: 0, onAttempt });
    for (const m of body.data || []) items.push(m);
    const next = body.paging && body.paging.next;
    url = next ? new URL(next) : null;
  }
  return items;
}
