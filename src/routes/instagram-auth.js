import { requireClipper, signSession, verifySession } from '../auth.js';
import { getParticipation, getCampaignById, now, linkParticipationAccount, findAccountClash, approvedAutoImportIntent } from '../db.js';
import { campaignPlatforms } from '../platforms.js';
import { canConnect } from '../access.js';
import { logError } from '../error-log.js';
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

// These two are normal flow, not a problem worth the founder's attention:
// NOT_APPROVED just means they haven't been approved yet (an expected step,
// happens on every clipper before approval), and DENIED means they cancelled
// Instagram's own permission screen (self-resolving -- they just try again).
// Logging either would flood error_log with noise instead of real failures.
const SILENT_CODES = new Set(['NOT_APPROVED', 'DENIED']);

async function failure(env, session, campaignId, e) {
  const q = new URLSearchParams({ ig: 'error' });
  if (campaignId) q.set('campaign', String(campaignId));
  let code, msg, fix;
  if (e instanceof IgError) {
    code = e.code; msg = e.message; fix = e.fix || '';
  } else {
    code = 'UNKNOWN';
    msg = e && e.message ? e.message : 'Instagram connection failed.';
    fix = 'Try again — if it keeps happening, tell the ClipGrow admin.';
  }
  q.set('code', code);
  q.set('msg', msg);
  q.set('fix', fix);
  if (!SILENT_CODES.has(code)) {
    // The session only carries the clipper's id, not their name -- one extra
    // lookup, but this path only runs on an actual failure, never on the
    // happy path.
    const clipper = session
      ? await env.DB.prepare('SELECT username, display_name FROM clippers WHERE id = ?').bind(session.sub).first()
      : null;
    await logError(env.DB, {
      actorType: 'clipper', actorId: session ? session.sub : null,
      actorLabel: clipper ? (clipper.display_name || clipper.username) : null,
      source: 'instagram_oauth', code, message: msg,
      detail: e && e.stack, path: campaignId ? `campaign ${campaignId}` : null
    });
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
      return failure(env, session, url.searchParams.get('campaign_id'), new IgError(
        'NOT_CONFIGURED',
        'Instagram connection is not switched on yet.',
        'The ClipGrow admin still needs to finish the Instagram app setup. Nothing you can fix from here.'
      ));
    }

    const campaignId = url.searchParams.get('campaign_id');
    if (!campaignId) return failure(env, session, null, new Error('No campaign was specified for this connection.'));

    const clipper = await env.DB.prepare('SELECT status FROM clippers WHERE id = ?').bind(session.sub).first();
    if (!clipper || clipper.status !== 'active') {
      return failure(env, session, campaignId, new Error('Your account is disabled, so accounts cannot be connected. Contact the ClipGrow admin.'));
    }

    const campaign = await getCampaignById(env.DB, campaignId);
    if (!campaign) return failure(env, session, campaignId, new Error('Campaign not found.'));
    if (!campaignPlatforms(campaign).includes('instagram')) {
      return failure(env, session, campaignId, new Error('This campaign does not accept Instagram.'));
    }

    const part = await getParticipation(env.DB, session.sub, campaignId);
    if (!part) return failure(env, session, campaignId, new Error('Join the campaign before connecting an account to it.'));
    if (part.status === 'kicked') return failure(env, session, campaignId, new Error('You have been removed from this campaign.'));

    // The account must have been approved (added as a Meta app Tester) first.
    // Enforced here and not only by hiding the button, because this URL is a
    // plain link a clipper could have kept from an earlier session. Without
    // approval Instagram would reject them anyway -- this just replaces an
    // opaque platform error with an explanation of what to do next.
    const gate = await canConnect(env.DB, session.sub, Number(campaignId), 'instagram');
    if (!gate.allowed) {
      return failure(env, session, campaignId, new IgError('NOT_APPROVED', gate.title, gate.reason));
    }

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
      return failure(env, session, campaignId, new IgError('DENIED', desc, 'Connect again and tap Allow on every permission Instagram asks for.'));
    }

    const code = url.searchParams.get('code');
    if (!session || !statePayload || !code) {
      return failure(env, session, campaignId, new Error('That connection link expired. Start the connection again.'));
    }
    if (String(statePayload.sub) !== String(session.sub)) {
      return failure(env, session, campaignId, new Error('That connection link belonged to a different login.'));
    }

    try {
      const part = await getParticipation(env.DB, session.sub, campaignId);
      if (!part) throw new Error('You are no longer part of this campaign.');

      const redirectUri = callbackUri(env, url);
      const shortLived = await exchangeCodeForToken(env, code, redirectUri);
      const longLived = await exchangeForLongLivedToken(env, shortLived.access_token);
      const profile = await fetchProfile(longLived.access_token); // rejects personal accounts
      const expiresAt = Date.now() + (longLived.expires_in || 0) * 1000;

      // One Instagram account drives one LIVE campaign at a time, checked
      // across every clipper. Shared with the YouTube route so both platforms
      // enforce the rule identically.
      const clash = await findAccountClash(env.DB, profile.id, 'instagram', campaignId);
      if (clash) {
        const mine = String(clash.clipper_id) === String(session.sub);
        throw new IgError(
          'ACCOUNT_IN_USE',
          mine
            ? `@${profile.username} is already connected to your "${clash.campaign_name}" campaign.`
            : `@${profile.username} is already connected to another ClipGrow campaign ("${clash.campaign_name}").`,
          mine
            ? 'Each live campaign needs its own Instagram account. Connect a different account, or use this one again once that campaign is marked over.'
            : 'If this is genuinely your account, ask the ClipGrow admin to release it.'
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
           status = 'connected', last_error_code = NULL, last_error_at = NULL WHERE id = ?`
        ).bind(profile.username, profile.account_type, longLived.access_token, expiresAt, accountId).run();
      } else {
        // Carries whatever the admin set at approval time (migration 016) --
        // paste-only from the first moment for someone approved specifically
        // because they post campaign work on a shared/main account, rather
        // than starting automatic and needing a separate manual toggle.
        const autoImport = await approvedAutoImportIntent(env.DB, session.sub, campaignId, 'instagram');
        const res = await env.DB.prepare(
          `INSERT INTO social_accounts (clipper_id, platform, external_id, username, account_type, access_token,
             token_expires_at, status, connected_at, auto_import)
           VALUES (?, 'instagram', ?, ?, ?, ?, ?, 'connected', ?, ?)`
        ).bind(session.sub, profile.id, profile.username, profile.account_type,
               longLived.access_token, expiresAt, now(), autoImport).run();
        accountId = res.meta.last_row_id;
      }

      await linkParticipationAccount(env.DB, part.id, accountId, 'instagram');

      const q = new URLSearchParams({ ig: 'connected', campaign: String(campaignId), handle: profile.username });
      return redirect('/dashboard.html?' + q.toString());
    } catch (e) {
      return failure(env, session, campaignId, e);
    }
  }

  return null;
}
