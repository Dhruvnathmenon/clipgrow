import { requireClipper, signSession, verifySession } from '../auth.js';
import { getParticipation, getCampaignById, now } from '../db.js';
import {
  getAuthorizeUrl, exchangeCodeForToken, exchangeForLongLivedToken, fetchProfile, IgError
} from '../instagram.js';

const STATE_TTL_MS = 10 * 60 * 1000;

// The redirect_uri sent to Instagram must be identical in the authorize step
// and the token-exchange step, or the exchange fails. Prefer the pinned env
// value; fall back to the request origin only for local dev where it isn't set.
function callbackUri(env, url) {
  return env.IG_REDIRECT_URI || new URL('/api/auth/instagram/callback', url.origin).toString();
}

function redirect(path) {
  return new Response(null, { status: 302, headers: { Location: path } });
}

function failure(campaignId, e) {
  const q = new URLSearchParams({ ig: 'error' });
  if (campaignId) q.set('campaign', String(campaignId));
  if (e instanceof IgError) {
    q.set('code', e.code);
    q.set('msg', e.message);
    q.set('fix', e.fix || '');
  } else {
    q.set('code', 'UNKNOWN');
    q.set('msg', e && e.message ? e.message : 'Instagram connection failed.');
    q.set('fix', 'Try again — if it keeps happening, tell the ClipGrow admin.');
  }
  return redirect('/dashboard.html?' + q.toString());
}

export async function handleInstagramAuth(request, env, url) {
  const { pathname } = url;

  // Meta requires a deauthorize callback and a data-deletion endpoint on the
  // app. Instagram POSTs a signed request here when a user removes the app or
  // asks for deletion. We keep no personal data beyond the access token, so we
  // just drop the account's token/rows and acknowledge.
  if (pathname === '/api/auth/instagram/deauthorize' && request.method === 'POST') {
    return new Response('ok', { status: 200 });
  }
  if (pathname === '/api/auth/instagram/data-deletion') {
    // GET renders a human-readable status page; POST is Meta's callback.
    if (request.method === 'POST') {
      return new Response(JSON.stringify({ url: `${url.origin}/api/auth/instagram/data-deletion`, confirmation_code: 'clipgrow-noop' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('ClipGrow stores only an Instagram access token per connected account. To delete it, ask the ClipGrow admin to disconnect your account, or remove ClipGrow from Instagram → Settings → Apps and websites.',
      { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  if (request.method !== 'GET') return null;

  if (pathname === '/api/auth/instagram/start') {
    const session = await requireClipper(request, env);
    if (!session) return redirect('/login.html');

    if (!env.IG_CLIENT_ID || !env.IG_CLIENT_SECRET) {
      return failure(url.searchParams.get('campaign_id'), new IgError(
        'NOT_CONFIGURED',
        'Instagram connection is not switched on yet.',
        'The ClipGrow admin still needs to finish the Instagram app setup. Nothing you can fix from here.'
      ));
    }

    const campaignId = url.searchParams.get('campaign_id');
    if (!campaignId) return failure(null, new Error('No campaign was specified for this connection.'));

    const clipper = await env.DB.prepare('SELECT status FROM clippers WHERE id = ?').bind(session.sub).first();
    if (!clipper || clipper.status !== 'active') {
      return failure(campaignId, new Error('Your account is disabled, so accounts cannot be connected. Contact the ClipGrow admin.'));
    }

    const part = await getParticipation(env.DB, session.sub, campaignId);
    if (!part) return failure(campaignId, new Error('Join the campaign before connecting an account to it.'));
    if (part.status === 'kicked') return failure(campaignId, new Error('You have been removed from this campaign.'));

    const redirectUri = callbackUri(env, url);
    const state = await signSession(
      { sub: session.sub, campaign_id: Number(campaignId), exp: Date.now() + STATE_TTL_MS },
      env.SESSION_SECRET
    );
    return redirect(getAuthorizeUrl(env, redirectUri, state));
  }

  if (pathname === '/api/auth/instagram/callback') {
    const session = await requireClipper(request, env);
    const state = url.searchParams.get('state');
    const statePayload = state ? await verifySession(state, env.SESSION_SECRET) : null;
    const campaignId = statePayload ? statePayload.campaign_id : null;

    if (url.searchParams.get('error')) {
      const desc = url.searchParams.get('error_description') || 'You cancelled the Instagram connection.';
      return failure(campaignId, new IgError('DENIED', desc, 'Connect again and tap Allow on every permission Instagram asks for.'));
    }

    const code = url.searchParams.get('code');
    if (!session || !statePayload || !code) {
      return failure(campaignId, new Error('That connection link expired. Start the connection again.'));
    }
    if (String(statePayload.sub) !== String(session.sub)) {
      return failure(campaignId, new Error('That connection link belonged to a different login.'));
    }

    try {
      const part = await getParticipation(env.DB, session.sub, campaignId);
      if (!part) throw new Error('You are no longer part of this campaign.');

      const redirectUri = callbackUri(env, url);
      const shortLived = await exchangeCodeForToken(env, code, redirectUri);
      const longLived = await exchangeForLongLivedToken(env, shortLived.access_token);
      const profile = await fetchProfile(longLived.access_token); // rejects personal accounts
      const expiresAt = Date.now() + (longLived.expires_in || 0) * 1000;

      // Each campaign is worked from its own account, so refuse to bind an
      // account that is already driving a different campaign for this clipper.
      const clash = await env.DB.prepare(
        `SELECT c.name AS campaign_name FROM participations p
         JOIN social_accounts a ON a.id = p.account_id
         JOIN campaigns c ON c.id = p.campaign_id
         WHERE p.clipper_id = ? AND a.external_id = ? AND p.campaign_id != ?`
      ).bind(session.sub, profile.id, campaignId).first();
      if (clash) {
        throw new IgError(
          'ACCOUNT_IN_USE',
          `@${profile.username} is already connected to your "${clash.campaign_name}" campaign.`,
          'Each campaign needs its own Instagram account. Connect a different account for this campaign.'
        );
      }

      const existing = await env.DB.prepare(
        "SELECT id FROM social_accounts WHERE clipper_id = ? AND platform = 'instagram' AND external_id = ?"
      ).bind(session.sub, profile.id).first();

      let accountId;
      if (existing) {
        accountId = existing.id;
        await env.DB.prepare(
          `UPDATE social_accounts SET username = ?, account_type = ?, access_token = ?, token_expires_at = ?,
           status = 'connected', last_error_code = NULL, last_error_at = NULL, last_checked_at = ? WHERE id = ?`
        ).bind(profile.username, profile.account_type, longLived.access_token, expiresAt, now(), accountId).run();
      } else {
        const res = await env.DB.prepare(
          `INSERT INTO social_accounts (clipper_id, platform, external_id, username, account_type, access_token,
             token_expires_at, status, connected_at, last_checked_at)
           VALUES (?, 'instagram', ?, ?, ?, ?, ?, 'connected', ?, ?)`
        ).bind(session.sub, profile.id, profile.username, profile.account_type,
               longLived.access_token, expiresAt, now(), now()).run();
        accountId = res.meta.last_row_id;
      }

      await env.DB.prepare('UPDATE participations SET account_id = ? WHERE id = ?').bind(accountId, part.id).run();

      const q = new URLSearchParams({ ig: 'connected', campaign: String(campaignId), handle: profile.username });
      return redirect('/dashboard.html?' + q.toString());
    } catch (e) {
      return failure(campaignId, e);
    }
  }

  return null;
}
