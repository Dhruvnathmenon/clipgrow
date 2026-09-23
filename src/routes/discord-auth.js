import { requireClipper, signSession, verifySession } from '../auth.js';
import { normaliseDiscordUsername, validateDiscordUsername, now } from '../db.js';
import { logError } from '../error-log.js';
import {
  discordAvailable, getAuthorizeUrl, exchangeCode, fetchUser, addToGuild, DiscordError
} from '../discord.js';

const STATE_TTL_MS = 10 * 60 * 1000;

// Same rule as instagram-auth.js: the redirect_uri sent at the authorize step
// and at the token exchange must be byte-identical, and must equal one of the
// Redirects registered on the Discord application.
function callbackUri(env, url) {
  return env.DISCORD_REDIRECT_URI || new URL('/api/auth/discord/callback', url.origin).toString();
}

function redirect(path) {
  return new Response(null, { status: 302, headers: { Location: path } });
}

// Cancelling Discord's own permission screen, or a Discord that is briefly
// busy, is normal and fixes itself on a retry -- not worth the admin's error log.
const SILENT_CODES = new Set(['DENIED', 'RATE_LIMITED', 'ALREADY_LINKED']);

async function failure(env, session, campaignId, e) {
  const q = new URLSearchParams({ discord: 'error' });
  if (campaignId) q.set('campaign', String(campaignId));
  let code, msg, fix;
  if (e instanceof DiscordError) {
    code = e.code; msg = e.message; fix = e.fix || '';
  } else {
    code = 'UNKNOWN';
    msg = e && e.message ? e.message : 'Discord connection failed.';
    fix = 'Try again. If it keeps happening, tell the ClipGrow admin.';
  }
  q.set('msg', msg);
  q.set('fix', fix);
  if (!SILENT_CODES.has(code)) {
    const clipper = session
      ? await env.DB.prepare('SELECT username, display_name FROM clippers WHERE id = ?').bind(session.sub).first()
      : null;
    await logError(env.DB, {
      actorType: 'clipper', actorId: session ? session.sub : null,
      actorLabel: clipper ? (clipper.display_name || clipper.username) : null,
      source: 'discord_oauth', code, message: msg,
      detail: e && e.stack, path: campaignId ? `campaign ${campaignId}` : null
    });
  }
  return redirect('/dashboard.html?' + q.toString());
}

export async function handleDiscordAuth(request, env, url) {
  const { pathname } = url;
  if (request.method !== 'GET') return null;

  if (pathname === '/api/auth/discord/start') {
    const session = await requireClipper(request, env);
    if (!session) return redirect('/login.html');

    const rawCampaign = url.searchParams.get('campaign_id');
    const campaignId = rawCampaign && /^\d+$/.test(rawCampaign) ? rawCampaign : null;

    if (!discordAvailable(env)) {
      return failure(env, session, campaignId, new DiscordError(
        'NOT_CONFIGURED', 'Discord connection is not switched on yet.',
        'The ClipGrow admin still needs to finish the Discord setup. Nothing you can fix from here.'));
    }

    const clipper = await env.DB.prepare('SELECT status, discord_user_id FROM clippers WHERE id = ?').bind(session.sub).first();
    if (!clipper || clipper.status !== 'active') {
      return failure(env, session, campaignId, new Error('Your account is disabled, so Discord cannot be connected. Contact the ClipGrow admin.'));
    }
    // A verified identity is not swapped out from the dashboard: changing it is
    // an admin decision, otherwise one person could keep re-pointing an account
    // at whichever Discord is convenient.
    if (clipper.discord_user_id) {
      return redirect('/dashboard.html?discord=linked' + (campaignId ? `&campaign=${campaignId}` : ''));
    }

    const state = await signSession(
      { sub: session.sub, purpose: 'discord', campaign_id: campaignId ? Number(campaignId) : null, exp: Date.now() + STATE_TTL_MS },
      env.SESSION_SECRET
    );
    return redirect(getAuthorizeUrl(env, callbackUri(env, url), state));
  }

  if (pathname === '/api/auth/discord/callback') {
    const session = await requireClipper(request, env);
    const state = url.searchParams.get('state');
    const statePayload = state ? await verifySession(state, env.SESSION_SECRET) : null;
    const campaignId = statePayload && statePayload.campaign_id ? statePayload.campaign_id : null;

    if (url.searchParams.get('error')) {
      return failure(env, session, campaignId, new DiscordError(
        'DENIED', 'You cancelled the Discord connection.', 'Connect again and choose Authorize on the Discord screen.'));
    }

    const code = url.searchParams.get('code');
    if (!session || !statePayload || statePayload.purpose !== 'discord' || !code) {
      return failure(env, session, campaignId, new Error('That connection link expired. Start the connection again.'));
    }
    if (String(statePayload.sub) !== String(session.sub)) {
      return failure(env, session, campaignId, new Error('That connection link belonged to a different login.'));
    }
    if (!discordAvailable(env)) {
      return failure(env, session, campaignId, new DiscordError('NOT_CONFIGURED', 'Discord connection is not switched on yet.', ''));
    }

    try {
      const token = await exchangeCode(env, code, callbackUri(env, url));
      const user = await fetchUser(token.access_token);

      // One Discord account, one ClipGrow account. Checked before anything is
      // written, and again by the unique index if two requests race.
      const clash = await env.DB.prepare('SELECT id FROM clippers WHERE discord_user_id = ? AND id != ?')
        .bind(user.id, session.sub).first();
      if (clash) {
        throw new DiscordError('ALREADY_LINKED',
          'That Discord account is already linked to another ClipGrow account.',
          'Each person can have one ClipGrow account. If this is genuinely yours, ask the ClipGrow admin.');
      }

      // Add them to the server BEFORE recording the link, so a banned account is
      // refused rather than recorded. Any other failure is not the clipper's
      // fault and does not undo a genuine identity, so the link stands and they
      // are told to join by invite.
      let joined = 'already';
      let joinProblem = null;
      try {
        joined = await addToGuild(env, user.id, token.access_token);
      } catch (e) {
        if (e instanceof DiscordError && e.code === 'BANNED') throw e;
        joinProblem = e;
      }

      try {
        await env.DB.prepare(
          `UPDATE clippers SET discord_user_id = ?, discord_handle = ?, discord_linked_at = ? WHERE id = ?`
        ).bind(user.id, user.handle, now(), session.sub).run();
      } catch (e) {
        if (/UNIQUE/i.test(String(e && e.message))) {
          throw new DiscordError('ALREADY_LINKED',
            'That Discord account is already linked to another ClipGrow account.',
            'Each person can have one ClipGrow account. If this is genuinely yours, ask the ClipGrow admin.');
        }
        throw e;
      }

      // The verified handle is the truth. Where it satisfies the same rule the
      // profile form applies, it replaces the free-text entry, so the two can
      // never disagree.
      const handle = normaliseDiscordUsername(user.handle);
      if (!validateDiscordUsername(handle)) {
        await env.DB.prepare('UPDATE clippers SET discord_username = ? WHERE id = ?').bind(handle, session.sub).run();
      }

      if (joinProblem) {
        await logError(env.DB, {
          actorType: 'clipper', actorId: session.sub, actorLabel: null,
          source: 'discord_oauth', code: joinProblem.code || 'JOIN_FAILED', message: joinProblem.message,
          detail: null, path: null
        });
      }

      const q = new URLSearchParams({ discord: 'linked', handle: user.handle });
      if (joined === 'joined') q.set('joined', '1');
      if (joinProblem) q.set('join', 'manual');
      if (campaignId) q.set('campaign', String(campaignId));
      return redirect('/dashboard.html?' + q.toString());
    } catch (e) {
      return failure(env, session, campaignId, e);
    }
  }

  return null;
}
