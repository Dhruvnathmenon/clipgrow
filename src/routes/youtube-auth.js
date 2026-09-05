import { requireClipper, signSession, verifySession } from '../auth.js';
import { getParticipation, getCampaignById, now, linkParticipationAccount, findAccountClash } from '../db.js';
import { campaignPlatforms } from '../platforms.js';
import { canConnect } from '../access.js';
import {
  getAuthorizeUrl, exchangeCodeForToken, fetchChannel, YtError, YT_ERRORS
} from '../youtube.js';

// YouTube OAuth, deliberately parallel to routes/instagram-auth.js.
//
// The one genuinely different risk: Google returns a refresh token only on the
// first consent unless prompt=consent is forced. src/youtube.js forces it and
// refuses any exchange that comes back without one, because an account that
// connects fine and then stops updating an hour later is far worse than one
// that visibly fails to connect.

const STATE_TTL_MS = 10 * 60 * 1000;

function callbackUri(env, url) {
  return env.YT_REDIRECT_URI || new URL('/api/auth/youtube/callback', url.origin).toString();
}

function redirect(path) {
  return new Response(null, { status: 302, headers: { Location: path } });
}

function failure(campaignId, e) {
  const q = new URLSearchParams({ yt: 'error' });
  if (campaignId) q.set('campaign', String(campaignId));
  if (e instanceof YtError) {
    q.set('code', e.code);
    q.set('msg', e.message);
    q.set('fix', e.fix || '');
  } else {
    q.set('code', 'UNKNOWN');
    q.set('msg', (e && e.message) || 'YouTube connection failed.');
    q.set('fix', 'Try again — if it keeps happening, tell the ClipGrow admin.');
  }
  return redirect('/dashboard.html?' + q.toString());
}

export async function handleYoutubeAuth(request, env, url) {
  const { pathname } = url;
  if (request.method !== 'GET') return null;
  if (!pathname.startsWith('/api/auth/youtube/')) return null;

  if (pathname === '/api/auth/youtube/start') {
    const session = await requireClipper(request, env);
    if (!session) return redirect('/clipper');

    const campaignId = url.searchParams.get('campaign_id');
    if (!campaignId) return failure(null, new Error('No campaign was specified for this connection.'));

    if (!env.YT_CLIENT_ID || !env.YT_CLIENT_SECRET) return failure(campaignId, YT_ERRORS.NOT_CONFIGURED());

    const clipper = await env.DB.prepare('SELECT status FROM clippers WHERE id = ?').bind(session.sub).first();
    if (!clipper || clipper.status !== 'active') {
      return failure(campaignId, new Error('Your account is disabled, so accounts cannot be connected. Contact the ClipGrow admin.'));
    }

    const campaign = await getCampaignById(env.DB, campaignId);
    if (!campaign) return failure(campaignId, new Error('Campaign not found.'));
    if (!campaignPlatforms(campaign).includes('youtube')) {
      return failure(campaignId, new Error('This campaign does not accept YouTube. Connect Instagram for it instead.'));
    }

    const part = await getParticipation(env.DB, session.sub, campaignId);
    if (!part) return failure(campaignId, new Error('Join the campaign before connecting an account to it.'));
    if (part.status === 'kicked') return failure(campaignId, new Error('You have been removed from this campaign.'));

    // The channel must have been approved by the admin first -- reinstated
    // after a clipper reported connecting a YouTube channel with no review
    // at all. This used to be a real platform-side allowlist gate (the
    // Google Cloud project was in Testing status, and only accounts on the
    // Test users list could sign in at all); the project going Published
    // removed THAT gate, but it was never replaced with ClipGrow's own
    // review of whether the channel suits the campaign, the way
    // IDENTIFIER_SPEC.youtube's own hint in access.js still promises.
    // Enforced here and not only by hiding the button, for the same reason
    // instagram-auth.js enforces it: this URL is a plain link a clipper
    // could have kept from an earlier session or simply typed.
    const gate = await canConnect(env.DB, session.sub, Number(campaignId), 'youtube');
    if (!gate.allowed) {
      return failure(campaignId, new YtError('NOT_APPROVED', gate.title, gate.reason));
    }

    const state = await signSession(
      { sub: session.sub, campaign_id: Number(campaignId), exp: Date.now() + STATE_TTL_MS },
      env.SESSION_SECRET
    );
    return redirect(getAuthorizeUrl(env, callbackUri(env, url), state));
  }

  if (pathname === '/api/auth/youtube/callback') {
    const session = await requireClipper(request, env);
    const state = url.searchParams.get('state');
    const statePayload = state ? await verifySession(state, env.SESSION_SECRET) : null;
    const campaignId = statePayload ? statePayload.campaign_id : null;

    if (url.searchParams.get('error')) {
      const desc = url.searchParams.get('error_description') || 'You cancelled the YouTube connection.';
      return failure(campaignId, new YtError('DENIED', desc,
        'Connect again and tap Allow on every permission Google asks for.'));
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

      const tokens = await exchangeCodeForToken(env, code, callbackUri(env, url));
      const channel = await fetchChannel(tokens.access_token);

      // One channel drives one live campaign at a time, checked across every
      // clipper. Released once that campaign is completed or the account is
      // revoked, so a good channel can be reused on the next campaign.
      const clash = await findAccountClash(env.DB, channel.id, 'youtube', campaignId);
      if (clash) {
        const mine = String(clash.clipper_id) === String(session.sub);
        throw new YtError(
          'ACCOUNT_IN_USE',
          mine
            ? `${channel.title || channel.username} is already connected to your "${clash.campaign_name}" campaign.`
            : `That YouTube channel is already connected to another ClipGrow campaign ("${clash.campaign_name}").`,
          mine
            ? 'Each live campaign needs its own channel. Connect a different one, or reuse this once that campaign is marked over.'
            : 'If this is genuinely your channel, ask the ClipGrow admin to release it.'
        );
      }

      const meta = JSON.stringify({ uploads_playlist: channel.uploads_playlist, title: channel.title });

      const existing = await env.DB.prepare(
        "SELECT id FROM social_accounts WHERE clipper_id = ? AND platform = 'youtube' AND external_id = ?"
      ).bind(session.sub, channel.id).first();

      let accountId;
      if (existing) {
        accountId = existing.id;
        await env.DB.prepare(
          `UPDATE social_accounts SET username = ?, account_type = 'channel', access_token = ?,
             refresh_token = ?, token_expires_at = ?, meta_json = ?, status = 'connected',
             last_error_code = NULL, last_error_at = NULL, last_checked_at = ? WHERE id = ?`
        ).bind(channel.username, tokens.access_token, tokens.refresh_token,
               tokens.expires_at, meta, now(), accountId).run();
      } else {
        const res = await env.DB.prepare(
          `INSERT INTO social_accounts (clipper_id, platform, external_id, username, account_type,
             access_token, refresh_token, token_expires_at, meta_json, status, connected_at, last_checked_at)
           VALUES (?, 'youtube', ?, ?, 'channel', ?, ?, ?, ?, 'connected', ?, ?)`
        ).bind(session.sub, channel.id, channel.username, tokens.access_token,
               tokens.refresh_token, tokens.expires_at, meta, now(), now()).run();
        accountId = res.meta.last_row_id;
      }

      await linkParticipationAccount(env.DB, part.id, accountId, 'youtube');

      const q = new URLSearchParams({
        yt: 'connected', campaign: String(campaignId), handle: channel.title || channel.username
      });
      return redirect('/dashboard.html?' + q.toString());
    } catch (e) {
      return failure(campaignId, e);
    }
  }

  return null;
}
