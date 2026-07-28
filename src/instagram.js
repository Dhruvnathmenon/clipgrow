const AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
const TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const GRAPH_BASE = 'https://graph.instagram.com';

// Scopes for "Instagram API with Instagram Login". Meta renames these
// occasionally -- override with the IG_SCOPES var if your app lists different
// strings on its Instagram product page.
const DEFAULT_SCOPES = 'instagram_business_basic,instagram_business_manage_insights';

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

// Maps a Meta Graph error payload onto one of our typed errors.
function classify(status, body) {
  const e = (body && body.error) || {};
  const code = e.code;
  const sub = e.error_subcode;
  const msg = e.message || '';

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

async function igFetch(url, { method = 'GET', body, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
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
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', env.IG_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', env.IG_SCOPES || DEFAULT_SCOPES);
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeCodeForToken(env, code, redirectUri) {
  const form = new URLSearchParams();
  form.set('client_id', env.IG_CLIENT_ID);
  form.set('client_secret', env.IG_CLIENT_SECRET);
  form.set('grant_type', 'authorization_code');
  form.set('redirect_uri', redirectUri);
  form.set('code', code);
  const res = await fetch(TOKEN_URL, { method: 'POST', body: form });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw classify(res.status, payload);
  return payload;
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
export async function findMediaByUrl(igUserId, accessToken, permalinkUrl) {
  const target = normalizePermalink(permalinkUrl);
  let url = new URL(`${GRAPH_BASE}/${igUserId}/media`);
  url.searchParams.set('fields', 'id,permalink,media_type,media_product_type,timestamp');
  url.searchParams.set('limit', '100');
  url.searchParams.set('access_token', accessToken);

  for (let page = 0; page < 10; page++) {
    const body = await igFetch(url.toString());
    const match = (body.data || []).find(m => m.permalink && normalizePermalink(m.permalink) === target);
    if (match) return match;
    const next = body.paging && body.paging.next;
    if (!next) break;
    url = new URL(next);
  }
  return null;
}

export function isVideoMedia(media) {
  const type = (media.media_type || '').toUpperCase();
  const product = (media.media_product_type || '').toUpperCase();
  return type === 'VIDEO' || product === 'REELS';
}

// Meta has shuffled view metrics over time; `views` is current, the rest are
// fallbacks for older media so a metric rename doesn't zero everyone's earnings.
const VIEW_METRICS = ['views', 'plays', 'video_views', 'impressions'];

export async function fetchMediaViews(mediaId, accessToken) {
  let lastErr;
  for (const metric of VIEW_METRICS) {
    const url = new URL(`${GRAPH_BASE}/${mediaId}/insights`);
    url.searchParams.set('metric', metric);
    url.searchParams.set('access_token', accessToken);
    try {
      const body = await igFetch(url.toString(), { retries: 1 });
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
