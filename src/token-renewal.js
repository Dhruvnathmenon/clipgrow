// Keeps Instagram connections alive so a clipper never has to reconnect.
//
// An Instagram long-lived token lasts 60 days. It can be extended for ANOTHER
// 60 days by calling graph.instagram.com/refresh_access_token any time while it
// is still valid and at least 24h old (src/instagram.js refreshLongLivedToken).
// Nothing was calling that, so every token simply expired on day 60 and its
// clipper hit "reconnect needed" -- a recurring wave of avoidable friction.
//
// This runs on the cron. Each pass renews the handful of tokens closest to
// expiry, so every connection gets refreshed roughly every ~48 days and never
// comes near the 60-day wall. A token that genuinely can't be renewed (the
// clipper revoked access in their own Instagram settings, or it already
// lapsed) is the ONLY case that still needs a real reconnect, and it is marked
// needs_reauth so the existing banners pick it up.

import { refreshLongLivedToken } from './instagram.js';
import { markAccount } from './earnings.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Renew once a token is inside this many days of expiring. 12 days of runway
// means a transient failure has ~2 more cron days (8 cron passes) to succeed
// before it matters.
export const RENEW_WITHIN_MS = 12 * DAY_MS;

// Cap per cron pass so this never eats into the refresh sweep's subrequest
// budget in the same invocation. The cron runs 4x/day, so this is 20
// renewals/day of capacity against a real need of well under one.
export const MAX_RENEWALS_PER_PASS = 5;

/**
 * @returns {{ renewed: number[], reauth: number[], failed: number[] }}
 *          account ids, by outcome.
 */
export async function renewInstagramTokens(db, env, { now = Date.now(), max = MAX_RENEWALS_PER_PASS, withinMs = RENEW_WITHIN_MS } = {}) {
  const { results } = await db.prepare(
    `SELECT id, access_token, token_expires_at
       FROM social_accounts
      WHERE platform = 'instagram' AND status = 'connected' AND access_token IS NOT NULL
        AND (token_expires_at IS NULL OR token_expires_at < ?)
      ORDER BY token_expires_at IS NULL DESC, token_expires_at ASC
      LIMIT ?`
  ).bind(now + withinMs, max).all();

  const out = { renewed: [], reauth: [], failed: [] };

  for (const acct of results || []) {
    try {
      const r = await refreshLongLivedToken(acct.access_token);
      if (!r || !r.access_token) { out.failed.push(acct.id); continue; }
      const expiresAt = now + (r.expires_in || 0) * 1000;
      // Guarded on status so a token disconnected between the SELECT and here
      // is not silently re-enabled.
      await db.prepare(
        `UPDATE social_accounts
            SET access_token = ?, token_expires_at = ?, last_error_code = NULL, last_error_at = NULL
          WHERE id = ? AND status = 'connected'`
      ).bind(r.access_token, expiresAt, acct.id).run();
      out.renewed.push(acct.id);
    } catch (e) {
      if (e && e.needsReauth) {
        // The token can't be saved -- the clipper revoked it, or it already
        // lapsed. This is a genuine reconnect, now the only kind.
        await markAccount(db, acct.id, { status: 'needs_reauth', code: (e && e.code) || 'TOKEN_EXPIRED' });
        out.reauth.push(acct.id);
      } else {
        // Transient (network, rate limit). Left as-is; it still has days of
        // runway and the next cron pass retries it.
        out.failed.push(acct.id);
      }
    }
  }

  return out;
}
