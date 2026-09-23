// The admin's side of Discord: releasing a link, and what happens to it when an
// account is archived.
//
// One Discord account can back only one ClipGrow account (a unique index), which
// is what makes "one account per person" real. That rule needs two ways out, or
// it strands people: an admin can release a link (hacked, banned or deleted
// Discord), and archiving an account frees its Discord along with its username.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleAdmin } from '../src/routes/admin.js';
import { handleDiscordAuth } from '../src/routes/discord-auth.js';
import { createSessionCookie } from '../src/auth.js';
import { COMPLETE_PROFILE } from './helpers/profile.mjs';

const NOW = Date.now();
const SECRET = 'test-secret';
const DISCORD = { DISCORD_CLIENT_ID: '111', DISCORD_CLIENT_SECRET: 'sek', DISCORD_BOT_TOKEN: 'bot', DISCORD_GUILD_ID: '999', DISCORD_LINK: 'optional' };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function world(extra = {}) {
  const base = { password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW, ...COMPLETE_PROFILE };
  return {
    DB: makeSqliteD1({
      clippers: [
        { id: 1, ...base, username: 'ravi', discord_user_id: '5550001', discord_handle: 'ravi.k', discord_linked_at: NOW },
        { id: 2, ...base, username: 'asha' }
      ],
      ...extra
    }),
    SESSION_SECRET: SECRET, ...DISCORD
  };
}

async function admin(env, path, { method = 'GET' } = {}) {
  const cookie = await createSessionCookie('admin', 'admin', SECRET);
  const request = new Request(`https://clipgrow.in${path}`, { method, headers: { Cookie: cookie.split(';')[0] } });
  return handleAdmin(request, env, new URL(request.url));
}
const row = (env, id) => env.DB._sqlite.prepare('SELECT * FROM clippers WHERE id = ?').get(id);

/* --------------------------------------------------------------- unlinking */

test('unlink releases the Discord and nothing else, and is recorded', async () => {
  const env = world();
  const res = await admin(env, '/api/admin/clippers/1/discord-unlink', { method: 'POST' });
  assert.equal(res.status, 200);
  const r = row(env, 1);
  assert.equal(r.discord_user_id, null);
  assert.equal(r.discord_handle, null);
  assert.equal(r.discord_linked_at, null);
  assert.equal(r.status, 'active', 'the account is untouched');
  assert.equal(r.username, 'ravi');
  const audit = env.DB._sqlite.prepare("SELECT action, target_label FROM staff_audit_log WHERE action = 'discord_unlinked'").all();
  assert.deepEqual(audit.map(a => ({ ...a })), [{ action: 'discord_unlinked', target_label: 'ravi' }]);
});

test('unlink refuses sensibly when there is nothing to release, or no such clipper', async () => {
  const env = world();
  assert.equal((await admin(env, '/api/admin/clippers/2/discord-unlink', { method: 'POST' })).status, 409, 'never linked');
  assert.equal((await admin(env, '/api/admin/clippers/999/discord-unlink', { method: 'POST' })).status, 404);
  await admin(env, '/api/admin/clippers/1/discord-unlink', { method: 'POST' });
  assert.equal((await admin(env, '/api/admin/clippers/1/discord-unlink', { method: 'POST' })).status, 409, 'a second click does not pretend to have done anything');
});

test('only an admin can unlink: no session, or a clipper session, is refused', async () => {
  const env = world();
  const anon = new Request('https://clipgrow.in/api/admin/clippers/1/discord-unlink', { method: 'POST' });
  assert.equal((await handleAdmin(anon, env, new URL(anon.url))).status, 401);
  const cookie = await createSessionCookie('clipper', 2, SECRET);
  const asClipper = new Request('https://clipgrow.in/api/admin/clippers/1/discord-unlink', { method: 'POST', headers: { Cookie: cookie.split(';')[0] } });
  assert.equal((await handleAdmin(asClipper, env, new URL(asClipper.url))).status, 401);
  assert.equal(row(env, 1).discord_user_id, '5550001', 'and nothing was released');
});

test('after an unlink the same person can link again, and the identity is theirs to reuse', async () => {
  const env = world();
  await admin(env, '/api/admin/clippers/1/discord-unlink', { method: 'POST' });
  globalThis.fetch = async input => {
    const url = String(input);
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    if (url.endsWith('/oauth2/token')) return json({ access_token: 't' });
    if (url.endsWith('/users/@me')) return json({ id: '5550001', username: 'ravi.k' });
    return new Response(null, { status: 204 });
  };
  const { signSession } = await import('../src/auth.js');
  const state = await signSession({ sub: 1, purpose: 'discord', campaign_id: null, exp: Date.now() + 60000 }, SECRET);
  const cookie = await createSessionCookie('clipper', 1, SECRET);
  const r = new Request(`https://clipgrow.in/api/auth/discord/callback?code=abc&state=${state}`, { headers: { Cookie: cookie.split(';')[0] } });
  const res = await handleDiscordAuth(r, env, new URL(r.url));
  assert.match(res.headers.get('Location'), /discord=linked/);
  assert.equal(row(env, 1).discord_user_id, '5550001');
});

/* ---------------------------------------------------------------- archiving */

test('archiving an account frees its Discord, so its owner can link a new account', async () => {
  const env = world();
  const res = await admin(env, '/api/admin/clippers/1', { method: 'DELETE' });
  assert.equal(res.status, 200);
  const r = row(env, 1);
  assert.equal(r.status, 'deleted');
  assert.equal(r.discord_user_id, null, 'the unique Discord slot is released');
  assert.equal(r.discord_handle, null);
  // The freed identity is now free for another account: the unique index allows it.
  env.DB._sqlite.prepare("UPDATE clippers SET discord_user_id = '5550001' WHERE id = 2").run();
  assert.equal(row(env, 2).discord_user_id, '5550001');
});

test('archiving an account that never linked Discord is unaffected', async () => {
  const env = world();
  assert.equal((await admin(env, '/api/admin/clippers/2', { method: 'DELETE' })).status, 200);
  assert.equal(row(env, 2).status, 'deleted');
});

/* ------------------------------------------------------------------ roster */

test('the admin roster shows who is verified and by which handle, and never the id', async () => {
  const env = world();
  const out = await (await admin(env, '/api/admin/clippers')).json();
  const ravi = out.clippers.find(c => c.username === 'ravi');
  const asha = out.clippers.find(c => c.username === 'asha');
  assert.equal(ravi.discord_linked, true);
  assert.equal(ravi.discord_handle, 'ravi.k');
  assert.equal(asha.discord_linked, false);
  assert.equal(JSON.stringify(out).includes('5550001'), false, 'the id is not needed to show a tick');
});

/* ------------------------------------------------------------------ health */

test('the Discord check also reports whether the bot is talking to ClipGrow', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ id: '111', username: 'Clipgrow' }), { status: 200 });

  const off = world();
  const a = await (await admin(off, '/api/admin/discord-health')).json();
  assert.deepEqual(a.bot_api, { enabled: false, last_call_at: null, calls_last_hour: 0 });

  const on = world(); on.BOT_API_TOKEN = 'zz-distinctive-secret-value';
  const t = Date.now();
  const ins = on.DB._sqlite.prepare('INSERT INTO bot_api_calls (ts, subject_hash) VALUES (?, ?)');
  ins.run(t - 5 * 60 * 1000, 'a'); ins.run(t - 2 * 60 * 1000, 'b'); ins.run(t - 3 * 60 * 60 * 1000, 'c');
  const b = await (await admin(on, '/api/admin/discord-health')).json();
  assert.equal(b.bot_api.enabled, true);
  assert.equal(b.bot_api.calls_last_hour, 2, 'only the last hour is counted');
  assert.ok(Math.abs(b.bot_api.last_call_at - (t - 2 * 60 * 1000)) < 5);
  assert.equal(JSON.stringify(b).includes('zz-distinctive-secret-value'), false, 'the token itself is never shown');
});
