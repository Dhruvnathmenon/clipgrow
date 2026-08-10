import * as ig from './instagram.js';
import * as yt from './youtube.js';

// One interface every platform implements, so the sync, earnings and route
// code never branches on platform name. Adding TikTok later means writing one
// more adapter and adding it to ADAPTERS -- nothing else changes.
//
// Each adapter exposes:
//   id                                     platform key stored on rows
//   label                                  human name for UI and error text
//   isConfigured(env)                      are the app credentials present?
//   fetchViews(account, mediaIds, env)     -> Map(mediaId -> views)
//   listRecent(account, {sinceTs}, env)    -> normalised media[]
//   findByUrl(account, url, env)           -> normalised media | null
//   refreshToken(account, env)             -> {access_token, expires_at, refresh_token?}
//   normalise(raw, env)                    -> normalised media
//
// A normalised medium is:
//   { external_id, permalink, thumbnail_url, posted_at, media_type,
//     duration_seconds, is_short, eligible, ineligible_reason }
//
// `eligible` is the adapter's verdict on whether a clip may earn at all. It is
// what keeps platform rules (YouTube counts Shorts only) out of the allocator.

export const PLATFORMS = ['instagram', 'youtube'];

const instagramAdapter = {
  id: 'instagram',
  label: 'Instagram',
  isConfigured: (env) => !!(env.IG_CLIENT_ID && env.IG_CLIENT_SECRET),

  normalise(m) {
    return {
      external_id: String(m.id),
      permalink: m.permalink || '',
      thumbnail_url: m.thumbnail_url || m.media_url || null,
      posted_at: m.timestamp ? Date.parse(m.timestamp) || null : null,
      media_type: m.media_product_type || m.media_type || null,
      duration_seconds: null,
      is_short: null,
      // Instagram already filters to Reels/video before this point.
      eligible: true,
      ineligible_reason: null
    };
  },

  // Instagram has no batch insights endpoint, so this is one call per clip.
  // The Map shape is what lets YouTube batch 50 per call behind the same API.
  async fetchViews(account, mediaIds) {
    const out = new Map();
    for (const id of mediaIds) {
      out.set(id, await ig.fetchMediaViews(id, account.access_token));
    }
    return out;
  },

  async listRecent(account, { sinceTs = 0 } = {}) {
    const raw = await ig.listRecentMedia(account.external_id, account.access_token, { sinceTs });
    return raw.filter(ig.isVideoMedia).map(m => this.normalise(m));
  },

  async findByUrl(account, url) {
    const m = await ig.findMediaByUrl(account.external_id, account.access_token, url);
    if (!m) throw ig.IG_ERRORS.MEDIA_NOT_FOUND();
    if (!ig.isVideoMedia(m)) throw ig.IG_ERRORS.NOT_VIDEO();
    return this.normalise(m);
  },

  async refreshToken(account) {
    const r = await ig.refreshLongLivedToken(account.access_token);
    return {
      access_token: r.access_token,
      expires_at: Date.now() + (r.expires_in || 0) * 1000
    };
  },

  // Instagram tokens last 60 days and are renewed by the scheduled job, so a
  // call never needs to refresh mid-flight.
  withFreshToken(account, env, fn) {
    return fn(account.access_token);
  }
};

const youtubeAdapter = {
  id: 'youtube',
  label: 'YouTube',
  isConfigured: (env) => !!(env.YT_CLIENT_ID && env.YT_CLIENT_SECRET),
  normalise: (m, env) => yt.normaliseVideo(m, env),
  fetchViews: (account, mediaIds, env) => yt.fetchViews(account, mediaIds, env),
  listRecent: (account, opts, env) => yt.listRecent(account, opts, env),
  findByUrl: (account, url, env) => yt.findByUrl(account, url, env),
  refreshToken: (account, env) => yt.refreshAccessToken(account, env),
  // Google access tokens last about an hour, so expiry mid-sync is routine and
  // has to be handled inline rather than surfacing as a failed clip.
  withFreshToken: (account, env, fn, onRefresh) => yt.withFreshToken(account, env, fn, onRefresh)
};

const ADAPTERS = {
  instagram: instagramAdapter,
  youtube: youtubeAdapter
};

export function getAdapter(platform) {
  return ADAPTERS[platform] || instagramAdapter;
}

export function platformLabel(platform) {
  return (ADAPTERS[platform] || {}).label || platform;
}

/** Platforms whose app credentials are actually present in this environment. */
export function configuredPlatforms(env) {
  return PLATFORMS.filter(p => ADAPTERS[p].isConfigured(env));
}

/**
 * Platforms a campaign accepts. Stored comma-separated; anything unparseable
 * falls back to Instagram so an odd value can never silently open a campaign
 * up to a platform the brand did not agree to.
 */
export function campaignPlatforms(campaignRow) {
  const raw = String((campaignRow && campaignRow.allowed_platforms) || 'instagram');
  const list = raw.split(',').map(s => s.trim().toLowerCase()).filter(p => PLATFORMS.includes(p));
  return list.length ? list : ['instagram'];
}
