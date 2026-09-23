// Connecting Discord: a verified identity, required before a clipper can start
// anything new -- but only once Discord linking is switched on, and never at the
// cost of reading or posting.
//
// Discord itself is faked (global fetch), so these cover OUR side of the
// contract: what we send, what we accept, what we refuse, and what we write.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleClipper } from '../src/routes/clipper.js';
import { handleDiscordAuth } from '../src/routes/discord-auth.js';
import { canConnect } from '../src/access.js';
import { discordHealth, discordConfigured, discordMode, discordAvailable, discordRequired } from '../src/discord.js';
import { createSessionCookie, signSession } from '../src/auth.js';
import { COMPLETE_PROFILE } from './helpers/profile.mjs';

const NOW = Date.now();
const SECRET = 'test-secret';
const DISCORD = { DISCORD_CLIENT_ID: '111', DISCORD_CLIENT_SECRET: 'sek', DISCORD_BOT_TOKEN: 'bot', DISCORD_GUILD_ID: '999' };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function world({ configured = true, mode = 'required', clippers } = {}) {
  const base = { username: 'c', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW, ...COMPLETE_PROFILE };
  return {
    DB: makeSqliteD1({
      clippers: clippers || [{ id: 1, ...base, username: 'c1' }, { id: 2, ...base, username: 'c2' }],
      campaigns: [{ id: 1, name: 'C', description: '', cpm: 40, budget: 100000, status: 'active', created_at: NOW,
                    model: 'cpm', min_views: 0, allowed_platforms: 'instagram' }],
      participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW }]
    }),
    SESSION_SECRET: SECRET,
    ...(configured ? DISCORD : {}),
    ...(configured ? { DISCORD_LINK: mode } : {})
  };
}

async function asClipper(env, id, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('clipper', id, SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method, headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const url = new URL(request.url);
  return path.startsWith('/api/auth/') ? handleDiscordAuth(request, env, url) : handleClipper(request, env, url);
}

// A scripted Discord. `discordUser` is who the OAuth code resolves to.
function fakeDiscord({ user = { id: '5550001', username: 'ravi.k', global_name: 'Ravi' }, put = 201, putBody = {}, tokenOk = true } = {}) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method || 'GET', body: init.body ? String(init.body) : null, auth: init.headers && init.headers.Authorization });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/oauth2/token')) return tokenOk ? json({ access_token: 'user-token' }) : json({ error: 'invalid_grant' }, 400);
    if (url.endsWith('/users/@me')) return json(user);
    if (url.includes('/guilds/999/members/')) return put === 204 ? new Response(null, { status: 204 }) : json(putBody, put);
    return json({}, 404);
  };
  return calls;
}

const stateFor = (sub, extra = {}) => signSession({ sub, purpose: 'discord', campaign_id: null, exp: Date.now() + 60000, ...extra }, SECRET);
// URLSearchParams writes a space as +, which decodeURIComponent leaves alone.
const readable = loc => decodeURIComponent(loc.split('+').join(' '));
const row = (env, id) => env.DB._sqlite.prepare('SELECT * FROM clippers WHERE id = ?').get(id);

/* ----------------------------------------------------------- the switch */

test('with Discord not configured nothing requires it and /me says so', async () => {
  const env = world({ configured: false });
  assert.equal(discordConfigured(env), false);
  const me = (await (await asClipper(env, 1, '/api/clipper/me')).json()).clipper;
  assert.deepEqual(me.discord, { available: false, required: false, linked: false, handle: null });
  const res = await asClipper(env, 1, '/api/clipper/campaigns/1/applications', { method: 'POST', body: { video_url: 'https://drive.google.com/file/d/x/view' } });
  assert.equal(res.status, 201, 'an unconfigured deployment must not strand anyone at a step it cannot offer');
});

test('all four values are needed before Discord is considered configured', () => {
  for (const k of Object.keys(DISCORD)) {
    const partial = { ...DISCORD }; delete partial[k];
    assert.equal(discordConfigured(partial), false, `${k} missing`);
  }
  assert.equal(discordConfigured(DISCORD), true);
});

// The four secrets can exist long before anyone should see a Connect button (they
// already did on production, left from an earlier attempt). How far Discord is
// switched on is its own decision: off, then optional, then required.
test('DISCORD_LINK moves Discord through off, optional and required -- and unknown values mean off', () => {
  const cases = [[undefined, 'off'], ['', 'off'], ['off', 'off'], ['optional', 'optional'], ['required', 'required'], ['REQUIRED', 'required'], ['yes', 'off'], ['1', 'off']];
  for (const [v, want] of cases) assert.equal(discordMode({ ...DISCORD, DISCORD_LINK: v }), want, String(v));
  assert.equal(discordMode({ DISCORD_LINK: 'required' }), 'off', 'the switch alone cannot turn on an unconfigured Discord');
  assert.equal(discordAvailable({ ...DISCORD, DISCORD_LINK: 'optional' }), true);
  assert.equal(discordRequired({ ...DISCORD, DISCORD_LINK: 'optional' }), false);
  assert.equal(discordRequired({ ...DISCORD, DISCORD_LINK: 'required' }), true);
});

test('off: secrets exist but nothing is shown, offered or refused', async () => {
  const env = world({ mode: 'off' });
  const me = (await (await asClipper(env, 2, '/api/clipper/me')).json()).clipper;
  assert.deepEqual(me.discord, { available: false, required: false, linked: false, handle: null });
  const res = await asClipper(env, 2, '/api/clipper/campaigns/1/join', { method: 'POST', body: {} });
  assert.equal(res.status, 201);
  const start = await asClipper(env, 2, '/api/auth/discord/start');
  assert.match(readable(start.headers.get('Location')), /not switched on/i, 'the route cannot be used while off');
});

test('optional: the Connect button is offered and works, but nothing is refused', async () => {
  const env = world({ mode: 'optional' });
  const me = (await (await asClipper(env, 2, '/api/clipper/me')).json()).clipper;
  assert.deepEqual(me.discord, { available: true, required: false, linked: false, handle: null });
  const res = await asClipper(env, 2, '/api/clipper/campaigns/1/join', { method: 'POST', body: {} });
  assert.equal(res.status, 201, 'connecting is offered, not yet demanded');
  const start = await asClipper(env, 2, '/api/auth/discord/start');
  assert.ok(start.headers.get('Location').startsWith('https://discord.com/oauth2/authorize'), 'and it can already be used voluntarily');
  const gate = await canConnect(env.DB, 1, 1, 'instagram', { requireDiscord: discordRequired(env) });
  assert.notEqual(gate.state, 'needs_discord');
});

/* ------------------------------------------------------------ the gate */

test('once configured, starting anything new is refused until Discord is linked', async () => {
  const env = world();
  const gated = [
    ['/api/clipper/campaigns/1/join', {}],
    ['/api/clipper/campaigns/1/applications', { video_url: 'https://drive.google.com/file/d/x/view' }],
    ['/api/clipper/campaigns/1/applications/upload-url', { mime_type: 'video/mp4', size_bytes: 1000 }],
    ['/api/clipper/access-request', { campaign_id: 1, platform: 'instagram', identifier: 'my.handle' }]
  ];
  for (const [path, body] of gated) {
    const res = await asClipper(env, 2, path, { method: 'POST', body });
    assert.equal(res.status, 403, `${path} must be refused`);
    assert.match((await res.json()).error, /connect your discord/i);
  }
});

test('reading earnings and campaigns is never blocked by the Discord step', async () => {
  const env = world();
  assert.equal((await asClipper(env, 2, '/api/clipper/me')).status, 200);
  assert.equal((await asClipper(env, 2, '/api/clipper/campaigns')).status, 200);
  const me = (await (await asClipper(env, 2, '/api/clipper/me')).json()).clipper;
  assert.deepEqual(me.discord, { available: true, required: true, linked: false, handle: null });
});

test('a linked clipper passes the gate, and /me shows only the handle', async () => {
  const env = world();
  env.DB._sqlite.prepare("UPDATE clippers SET discord_user_id = '5550001', discord_handle = 'ravi.k' WHERE id = 2").run();
  const res = await asClipper(env, 2, '/api/clipper/campaigns/1/join', { method: 'POST', body: {} });
  assert.equal(res.status, 201);
  const me = (await (await asClipper(env, 2, '/api/clipper/me')).json()).clipper;
  assert.deepEqual(me.discord, { available: true, required: true, linked: true, handle: 'ravi.k' });
  assert.equal(JSON.stringify(me).includes('5550001'), false, 'the Discord id is never sent to the browser');
});

test('canConnect asks for Discord first, but only when told Discord is on', async () => {
  const env = world();
  const on = await canConnect(env.DB, 1, 1, 'instagram', { requireDiscord: true });
  assert.equal(on.allowed, false);
  assert.equal(on.state, 'needs_discord');
  const off = await canConnect(env.DB, 1, 1, 'instagram');
  assert.notEqual(off.state, 'needs_discord', 'the old call shape is unchanged');
});

/* ------------------------------------------------------------ OAuth: start */

test('start: no session goes to login; not configured says so; configured redirects to Discord with the right scopes', async () => {
  const anon = new Request('https://clipgrow.in/api/auth/discord/start');
  const res0 = await handleDiscordAuth(anon, world(), new URL(anon.url));
  assert.equal(res0.headers.get('Location'), '/login.html');

  const off = await asClipper(world({ configured: false }), 1, '/api/auth/discord/start');
  assert.match(off.headers.get('Location'), /discord=error/);
  assert.match(readable(off.headers.get('Location')), /not switched on/i);

  const res = await asClipper(world(), 1, '/api/auth/discord/start?campaign_id=1');
  const loc = new URL(res.headers.get('Location'));
  assert.equal(loc.origin + loc.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(loc.searchParams.get('client_id'), '111');
  assert.equal(loc.searchParams.get('scope'), 'identify guilds.join');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://clipgrow.in/api/auth/discord/callback');
  assert.ok(loc.searchParams.get('state'));
});

test('start: an already-linked clipper is not sent back through Discord', async () => {
  const env = world();
  env.DB._sqlite.prepare("UPDATE clippers SET discord_user_id = '5550001' WHERE id = 1").run();
  const res = await asClipper(env, 1, '/api/auth/discord/start');
  assert.match(res.headers.get('Location'), /discord=linked/);
});

test('start: a disabled account cannot link', async () => {
  const env = world();
  env.DB._sqlite.prepare("UPDATE clippers SET status = 'disabled' WHERE id = 1").run();
  const res = await asClipper(env, 1, '/api/auth/discord/start');
  assert.match(res.headers.get('Location'), /discord=error/);
});

/* -------------------------------------------------------- OAuth: callback */

test('callback: links the verified identity, adds them to the server, and replaces the typed handle', async () => {
  const env = world();
  const calls = fakeDiscord();
  const res = await asClipper(env, 1, `/api/auth/discord/callback?code=abc&state=${await stateFor(1)}`);
  const loc = res.headers.get('Location');
  assert.match(loc, /discord=linked/);
  assert.match(loc, /joined=1/);

  const r = row(env, 1);
  assert.equal(r.discord_user_id, '5550001');
  assert.equal(r.discord_handle, 'ravi.k');
  assert.ok(r.discord_linked_at > 0);
  assert.equal(r.discord_username, 'ravi.k', 'the verified handle wins over free text');

  const join = calls.find(c => c.method === 'PUT');
  assert.match(join.url, /\/guilds\/999\/members\/5550001$/);
  assert.equal(join.auth, 'Bot bot');
  assert.equal(JSON.parse(join.body).access_token, 'user-token');
});

test('callback: already a member (204) is success, not an error', async () => {
  const env = world();
  fakeDiscord({ put: 204 });
  const res = await asClipper(env, 1, `/api/auth/discord/callback?code=abc&state=${await stateFor(1)}`);
  assert.match(res.headers.get('Location'), /discord=linked/);
  assert.equal(row(env, 1).discord_user_id, '5550001');
});

test('callback: a Discord account already on another ClipGrow account is refused and nothing is written', async () => {
  const env = world();
  env.DB._sqlite.prepare("UPDATE clippers SET discord_user_id = '5550001' WHERE id = 2").run();
  fakeDiscord();
  const res = await asClipper(env, 1, `/api/auth/discord/callback?code=abc&state=${await stateFor(1)}`);
  assert.match(res.headers.get('Location'), /discord=error/);
  assert.match(readable(res.headers.get('Location')), /already linked to another/i);
  assert.equal(row(env, 1).discord_user_id, null);
});

test('the unique index is the backstop when two links race', () => {
  const env = world();
  env.DB._sqlite.prepare("UPDATE clippers SET discord_user_id = '7' WHERE id = 1").run();
  assert.throws(() => env.DB._sqlite.prepare("UPDATE clippers SET discord_user_id = '7' WHERE id = 2").run(), /UNIQUE/i);
  env.DB._sqlite.prepare("UPDATE clippers SET discord_user_id = NULL WHERE id = 2").run();
  env.DB._sqlite.prepare("UPDATE clippers SET discord_user_id = NULL WHERE id = 1").run();   // NULLs never collide
});

test('callback: an account banned from the server is refused, not recorded', async () => {
  const env = world();
  fakeDiscord({ put: 403, putBody: { code: 40007, message: 'The user is banned from this guild.' } });
  const res = await asClipper(env, 1, `/api/auth/discord/callback?code=abc&state=${await stateFor(1)}`);
  assert.match(readable(res.headers.get('Location')), /banned/i);
  assert.equal(row(env, 1).discord_user_id, null);
});

test('callback: if only the auto-join fails, the identity still counts and they are told to join by invite', async () => {
  const env = world();
  fakeDiscord({ put: 400, putBody: { code: 30001, message: 'Maximum number of guilds reached' } });
  const res = await asClipper(env, 1, `/api/auth/discord/callback?code=abc&state=${await stateFor(1)}`);
  const loc = res.headers.get('Location');
  assert.match(loc, /discord=linked/);
  assert.match(loc, /join=manual/);
  assert.equal(row(env, 1).discord_user_id, '5550001');
  const logged = env.DB._sqlite.prepare("SELECT source, code FROM error_log WHERE source = 'discord_oauth'").all();
  assert.equal(logged.length, 1, 'the admin can see that auto-join is failing');
});

test('callback: a forged, expired, wrong-purpose or other-person state is refused', async () => {
  const env = world();
  fakeDiscord();
  const bad = [
    'not-a-token',
    await stateFor(1, { exp: Date.now() - 1000 }),
    await stateFor(1, { purpose: 'instagram' }),
    await stateFor(2)                                // signed for a different clipper
  ];
  for (const state of bad) {
    const res = await asClipper(env, 1, `/api/auth/discord/callback?code=abc&state=${encodeURIComponent(state)}`);
    assert.match(res.headers.get('Location'), /discord=error/);
  }
  assert.equal(row(env, 1).discord_user_id, null);
});

test('callback: cancelling on Discord is quiet -- an error for the clipper, no noise in the admin log', async () => {
  const env = world();
  const res = await asClipper(env, 1, `/api/auth/discord/callback?error=access_denied&state=${await stateFor(1)}`);
  assert.match(res.headers.get('Location'), /discord=error/);
  assert.equal(env.DB._sqlite.prepare("SELECT COUNT(*) n FROM error_log").get().n, 0);
});

test('callback: Discord rejecting the code is reported and logged for the admin', async () => {
  const env = world();
  fakeDiscord({ tokenOk: false });
  const res = await asClipper(env, 1, `/api/auth/discord/callback?code=abc&state=${await stateFor(1)}`);
  assert.match(res.headers.get('Location'), /discord=error/);
  assert.equal(row(env, 1).discord_user_id, null);
  assert.equal(env.DB._sqlite.prepare("SELECT COUNT(*) n FROM error_log WHERE source = 'discord_oauth'").get().n, 1);
});

/* ------------------------------------------------------------- health */

test('health: names what is missing without inventing a problem', async () => {
  const h = await discordHealth({});
  assert.equal(h.ok, false);
  assert.equal(h.configured, false);
  assert.match(h.checks[0].detail, /DISCORD_CLIENT_ID/);
});

test('health: reports each link in the chain, and never a secret', async () => {
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith('/oauth2/token')) return new Response('{}', { status: 401 });
    return new Response('{}', { status: 200 });
  };
  const h = await discordHealth(DISCORD);
  assert.equal(h.configured, true);
  assert.equal(h.ok, false);
  const byName = Object.fromEntries(h.checks.map(c => [c.name, c.ok]));
  assert.equal(byName['Bot token works'], true);
  assert.equal(byName['Bot is in the server'], true);
  assert.equal(byName['Client ID and secret match'], false);
  const text = JSON.stringify(h);
  for (const secret of ['sek', 'bot"']) assert.equal(text.includes(secret), false);
});

test('health: flags a bot token that belongs to a different application than the client ID', async () => {
  const mk = botId => async input => {
    const url = String(input);
    if (url.endsWith('/users/@me')) return new Response(JSON.stringify({ id: botId, username: 'Clipcore' }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  globalThis.fetch = mk('222');                              // the client id is 111
  const bad = await discordHealth(DISCORD);
  assert.equal(bad.checks.find(c => c.name === 'Bot and login are the same app').ok, false);
  assert.match(bad.checks.find(c => c.name === 'Bot token works').detail, /Clipcore/, 'says which bot it is');

  globalThis.fetch = mk('111');
  const good = await discordHealth(DISCORD);
  assert.equal(good.checks.find(c => c.name === 'Bot and login are the same app').ok, true);
  assert.equal(good.ok, true);
});
