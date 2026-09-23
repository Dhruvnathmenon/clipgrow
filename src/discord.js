// Discord, from the Worker's side: sign a clipper's identity in, add them to the
// ClipGrow server, and report whether the wiring is healthy.
//
// Nothing here needs the Clipcore bot PROCESS to be running. The bot token is
// just a credential for Discord's REST API, so adding a member (and, later,
// sending a DM) works even while the bot host is down -- which is what keeps the
// website independent of it.

const API = 'https://discord.com/api/v10';
const SCOPES = 'identify guilds.join';

export class DiscordError extends Error {
  constructor(code, message, fix) {
    super(message);
    this.name = 'DiscordError';
    this.code = code;
    this.fix = fix || '';
  }
}

// Every value the Worker needs. Without all four, Discord linking is simply not
// switched on yet, and nothing that depends on it is enforced.
export function discordConfigured(env) {
  return Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.DISCORD_BOT_TOKEN && env.DISCORD_GUILD_ID);
}

// How far Discord linking is switched on, separately from the secrets existing.
// The four secrets can sit there long before anyone should see a Connect button
// (they did, from an earlier attempt), and enforcing on their mere presence would
// stop every clipper joining, applying or connecting at once. DISCORD_LINK is a
// committed value in wrangler.jsonc, so each step is a reviewable, revertable
// deploy:
//   off       (default) nothing shown, nothing enforced, the admin check still runs
//   optional  the Connect button is offered, nothing is refused
//   required  joining, sending a video and connecting an account need it
// Anything unrecognised means off.
export function discordMode(env) {
  if (!discordConfigured(env)) return 'off';
  const m = String(env.DISCORD_LINK || '').toLowerCase();
  return m === 'optional' || m === 'required' ? m : 'off';
}
export const discordAvailable = env => discordMode(env) !== 'off';
export const discordRequired = env => discordMode(env) === 'required';

export function getAuthorizeUrl(env, redirectUri, state) {
  const q = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    state
  });
  return `https://discord.com/oauth2/authorize?${q.toString()}`;
}

async function readJson(res) {
  try { return await res.json(); } catch { return {}; }
}

function rateLimited() {
  return new DiscordError('RATE_LIMITED', 'Discord is busy right now.', 'Wait a minute and connect again.');
}

export async function exchangeCode(env, code, redirectUri) {
  const res = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    })
  });
  if (res.status === 429) throw rateLimited();
  const body = await readJson(res);
  if (!res.ok || !body.access_token) {
    throw new DiscordError(
      'TOKEN_EXCHANGE',
      'Discord did not accept the connection.',
      body.error === 'invalid_client'
        ? 'The ClipGrow admin needs to check the Discord app credentials.'
        : 'Start the connection again.'
    );
  }
  return body;
}

export async function fetchUser(accessToken) {
  const res = await fetch(`${API}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 429) throw rateLimited();
  const u = await readJson(res);
  if (!res.ok || !u.id) throw new DiscordError('NO_IDENTITY', 'Could not read your Discord account.', 'Start the connection again.');
  return { id: String(u.id), handle: String(u.username || ''), name: u.global_name || u.username || '' };
}

// Puts the person in the ClipGrow server using the access token they just
// granted (the guilds.join scope). 201 = newly added, 204 = already a member --
// both are success, so it is safe to call every time without checking first.
// Returns 'joined' | 'already'. A ban is refused outright; anything else is
// thrown as JOIN_FAILED and the caller decides (linking still stands).
export async function addToGuild(env, userId, accessToken) {
  const res = await fetch(`${API}/guilds/${env.DISCORD_GUILD_ID}/members/${userId}`, {
    method: 'PUT',
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: accessToken })
  });
  if (res.status === 201) return 'joined';
  if (res.status === 204) return 'already';
  if (res.status === 429) throw rateLimited();
  const body = await readJson(res);
  if (res.status === 403 && body.code === 40007) {
    throw new DiscordError('BANNED', 'This Discord account is banned from the ClipGrow server.', 'Contact the ClipGrow admin.');
  }
  throw new DiscordError('JOIN_FAILED', `Discord would not add you to the ClipGrow server (${res.status}).`, 'Join with the invite link in the ClipGrow announcements.');
}

// Reports which link in the chain is broken, in plain words, without ever
// showing a secret. Mirrors driveHealth().
export async function discordHealth(env) {
  const checks = [];
  const add = (name, ok, detail, fix) => checks.push({ name, ok, detail, fix: ok ? '' : (fix || '') });

  const missing = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID'].filter(k => !env[k]);
  if (missing.length) {
    add('Settings present', false, `Missing: ${missing.join(', ')}`,
      'Add the missing values as Worker secrets. Until then Discord linking stays switched off and nothing requires it.');
    return { ok: false, configured: false, checks };
  }
  add('Settings present', true, 'All four Discord values are set.');

  try {
    const res = await fetch(`${API}/users/@me`, { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } });
    const me = res.ok ? await readJson(res) : {};
    add('Bot token works', res.ok, res.ok ? `Discord accepts the bot token (bot: ${me.username || 'unknown'}).` : `Discord answered ${res.status}.`,
      'The bot token is wrong or was reset. Copy the current token from the Discord developer portal and set it again.');
    // Adding someone to the server needs the bot and the OAuth login to belong to
    // the SAME Discord application; a bot user's id is its application's id.
    if (res.ok && me.id) {
      const same = String(me.id) === String(env.DISCORD_CLIENT_ID);
      add('Bot and login are the same app', same,
        same ? 'The bot token and the client ID come from one application.' : 'The bot token belongs to a different application than DISCORD_CLIENT_ID.',
        'Take DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET and DISCORD_BOT_TOKEN all from the one Discord application that owns the ClipGrow bot.');
    }
  } catch (e) {
    add('Bot token works', false, 'Could not reach Discord.', 'Try again in a minute.');
  }

  try {
    const res = await fetch(`${API}/guilds/${env.DISCORD_GUILD_ID}`, { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } });
    add('Bot is in the server', res.ok, res.ok ? 'The bot can see the ClipGrow server.' : `Discord answered ${res.status}.`,
      'Check DISCORD_GUILD_ID is the right server and the bot has been added to it.');
  } catch (e) {
    add('Bot is in the server', false, 'Could not reach Discord.', 'Try again in a minute.');
  }

  try {
    const res = await fetch(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'client_credentials', scope: 'identify'
      })
    });
    add('Client ID and secret match', res.ok, res.ok ? 'Discord accepts the app credentials.' : `Discord answered ${res.status}.`,
      'DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET must both come from the same Discord application (OAuth2 page).');
  } catch (e) {
    add('Client ID and secret match', false, 'Could not reach Discord.', 'Try again in a minute.');
  }

  return { ok: checks.every(c => c.ok), configured: true, checks };
}
