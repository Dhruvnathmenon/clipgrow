// One account per email, per phone number and per Discord username.
//
// The point is to stop one person making account after account, so what is pinned
// here is the ways people actually try: the same Gmail with dots or a +tag added,
// the same number written differently, the same Discord name in another case --
// at sign-up, from the profile screen, and from the admin's edit -- and that the
// database, not just a check, is what holds the line.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleClipper } from '../src/routes/clipper.js';
import { handleAdmin } from '../src/routes/admin.js';
import { handleDiscordAuth } from '../src/routes/discord-auth.js';
import { createSessionCookie, signSession } from '../src/auth.js';
import { LIMITS } from '../src/signup.js';
import { identityKeys, identityConflict, duplicateField } from '../src/identity.js';
import { emailKey, phoneKey, discordKey } from '../components/profile-validation.js';
import { COMPLETE_PROFILE } from './helpers/profile.mjs';

const SECRET = 'test-secret';
const NOW = Date.now();
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/* ------------------------------------------------------------- the keys */

test('every spelling of one Gmail inbox is one email', () => {
  const same = ['name@gmail.com', 'NAME@gmail.com', 'n.a.m.e@gmail.com', 'name+spam@gmail.com', 'n.a.m.e+2@Gmail.com', 'name@googlemail.com'];
  for (const e of same) assert.equal(emailKey(e), 'name@gmail.com', e);
});

test('other providers keep their dots (they matter) but lose a +tag', () => {
  assert.equal(emailKey('first.last@example.in'), 'first.last@example.in');
  assert.notEqual(emailKey('first.last@example.in'), emailKey('firstlast@example.in'));
  assert.equal(emailKey('first.last+jobs@example.in'), 'first.last@example.in');
  assert.equal(emailKey('  Ravi@Example.IN '), 'ravi@example.in');
});

test('an email that is not one has no key, so it can never collide', () => {
  for (const bad of ['', '   ', 'plain', '@example.com', null, undefined, '+@gmail.com']) assert.equal(emailKey(bad), null, String(bad));
});

test('a phone number is its ten digits however it is written', () => {
  for (const n of ['9876543210', '+91 98765 43210', '098765 43210', '91-98765-43210', '(98765) 43210']) assert.equal(phoneKey(n), '9876543210', n);
  for (const bad of ['', '12345', '5876543210', 'abc']) assert.equal(phoneKey(bad), null, bad);
});

test('a Discord username ignores case and a pasted @', () => {
  assert.equal(discordKey('@Ravi.K'), 'ravi.k');
  assert.equal(discordKey('ravi.k'), 'ravi.k');
  assert.equal(discordKey('  '), null);
});

/* ----------------------------------------------------------- the database */

test('the database refuses two live accounts with the same email, phone or Discord', () => {
  const db = makeSqliteD1({});
  const ins = (username, keys) => db._sqlite.prepare(
    `INSERT INTO clippers (username, password_hash, password_salt, status, created_at, email_key, phone_key, discord_key)
     VALUES (?, 'h', 's', 'active', ?, ?, ?, ?)`).run(username, NOW, keys.email, keys.phone, keys.discord);
  ins('one', { email: 'a@x.com', phone: '9876543210', discord: 'aa' });
  for (const [what, keys] of [
    ['email', { email: 'a@x.com', phone: '9000000001', discord: 'bb' }],
    ['phone', { email: 'b@x.com', phone: '9876543210', discord: 'bb' }],
    ['discord', { email: 'b@x.com', phone: '9000000001', discord: 'aa' }]
  ]) {
    assert.throws(() => ins('two', keys), e => duplicateField(e) === (what === 'phone' ? 'phone' : what), `${what} must be unique`);
  }
  ins('three', { email: null, phone: null, discord: null });
  ins('four', { email: null, phone: null, discord: null });   // any number of accounts with nothing on file
});

test('a deleted account does not hold its email, phone or Discord', () => {
  const db = makeSqliteD1({});
  const ins = (username, status) => db._sqlite.prepare(
    `INSERT INTO clippers (username, password_hash, password_salt, status, created_at, email_key, phone_key, discord_key)
     VALUES (?, 'h', 's', ?, ?, 'a@x.com', '9876543210', 'aa')`).run(username, status, NOW);
  ins('old', 'deleted');
  ins('new', 'active');           // fine: the deleted one is outside the rule
  assert.throws(() => ins('newer', 'active'));
});

/* ------------------------------------------------------------- sign-up */

const GOOD = { username: 'ravi.kumar', password: 'correct-horse-9', email: 'ravi@gmail.com', contactNumber: '9876543210', discordUsername: 'ravi.k' };

function signupWorld() { return { DB: makeSqliteD1({}), SESSION_SECRET: SECRET, CLIPPER_SIGNUP: 'open' }; }
async function signup(env, body, ip = '203.0.113.7') {
  const req = new Request('https://clipgrow.in/api/clipper/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify(body)
  });
  return handleClipper(req, env, new URL(req.url));
}
const rows = env => env.DB._sqlite.prepare('SELECT * FROM clippers').all();

test('sign-up stores the details and their keys, in the same write as the account', async () => {
  const env = signupWorld();
  assert.equal((await signup(env, GOOD)).status, 201);
  const [r] = rows(env);
  assert.equal(r.email, 'ravi@gmail.com');
  assert.equal(r.contact_number, '9876543210');
  assert.equal(r.discord_username, 'ravi.k');
  assert.deepEqual([r.email_key, r.phone_key, r.discord_key], ['ravi@gmail.com', '9876543210', 'ravi.k']);
  assert.ok(r.last_seen_at, 'a new account starts its unused-account clock at sign-up');
});

test('every detail is required, and a bad one says which box it belongs to', async () => {
  for (const [field, patch] of [
    ['email', { email: '' }], ['email', { email: 'nope' }], ['email', { email: 'ravi@gmial.com' }],
    ['phone', { contactNumber: '' }], ['phone', { contactNumber: '12345' }], ['phone', { contactNumber: '9999999999' }],
    ['discord', { discordUsername: '' }], ['discord', { discordUsername: 'has space' }]
  ]) {
    const env = signupWorld();
    const res = await signup(env, { ...GOOD, ...patch });
    assert.equal(res.status, 400, JSON.stringify(patch));
    assert.equal((await res.json()).field, field, JSON.stringify(patch));
    assert.equal(rows(env).length, 0, 'nothing is created');
  }
});

test('the same email cannot sign up twice, however it is spelled', async () => {
  const env = signupWorld();
  await signup(env, GOOD);
  let n = 0;
  for (const email of ['ravi@gmail.com', 'RAVI@Gmail.com', 'r.a.v.i@gmail.com', 'ravi+two@gmail.com', 'ravi@googlemail.com']) {
    n++;
    const res = await signup(env, { username: `other.${n}`, password: 'correct-horse-9', email, contactNumber: `98111${String(10000 + n)}`, discordUsername: `other_${n}` }, `198.51.100.${n}`);
    assert.equal(res.status, 409, email);
    const body = await res.json();
    assert.equal(body.field, 'email', email);
    assert.match(body.error, /already used by another ClipGrow account/);
  }
  assert.equal(rows(env).length, 1);
});

test('the same phone number cannot sign up twice, however it is written', async () => {
  const env = signupWorld();
  await signup(env, GOOD);
  let n = 0;
  for (const contactNumber of ['9876543210', '+91 98765 43210', '098765 43210']) {
    n++;
    const res = await signup(env, { username: `other.${n}`, password: 'correct-horse-9', email: `other${n}@example.com`, contactNumber, discordUsername: `other_${n}` }, `198.51.100.${n}`);
    assert.equal(res.status, 409, contactNumber);
    assert.equal((await res.json()).field, 'phone');
  }
  assert.equal(rows(env).length, 1);
});

test('the same Discord username cannot sign up twice, whatever the case', async () => {
  const env = signupWorld();
  await signup(env, GOOD);
  for (const [i, discordUsername] of ['ravi.k', 'RAVI.K', '@ravi.k'].entries()) {
    const res = await signup(env, { username: `other.${i}`, password: 'correct-horse-9', email: `other${i}@example.com`, contactNumber: `98111${String(10000 + i)}`, discordUsername }, `198.51.100.${i}`);
    assert.equal(res.status, 409, discordUsername);
    assert.equal((await res.json()).field, 'discord');
  }
});

test('different people with different details sign up fine', async () => {
  const env = signupWorld();
  assert.equal((await signup(env, GOOD)).status, 201);
  const res = await signup(env, { username: 'asha.nair', password: 'another-pass-77', email: 'asha@example.in', contactNumber: '9123456780', discordUsername: 'asha_n' }, '198.51.100.9');
  assert.equal(res.status, 201);
});

test('being refused for a taken detail counts against the address, so the form cannot be used to probe a list', async () => {
  const env = signupWorld();
  await signup(env, GOOD, '192.0.2.50');
  let refused = 0, limited = false;
  for (let i = 0; i < LIMITS.perIpHour + 2; i++) {
    const res = await signup(env, { username: `probe.${i}`, password: 'correct-horse-9', email: 'ravi@gmail.com', contactNumber: `98111${String(10000 + i)}`, discordUsername: `probe_${i}` }, '192.0.2.50');
    if (res.status === 429) { limited = true; break; }
    if (res.status === 409) refused++;
  }
  assert.ok(limited, 'the address is shut out after a handful of tries');
  assert.ok(refused >= 1 && refused < LIMITS.perIpHour + 2);
});

test('two sign-ups racing past the check cannot both get in: the database decides and the message names the detail', async () => {
  const env = signupWorld();
  await signup(env, GOOD);
  // Skip the pre-check the way a true race would, by inserting straight away.
  const keys = identityKeys({ email: 'ravi@gmail.com', contact_number: '9111111111', discord_username: 'x' });
  assert.equal(await identityConflict(env.DB, keys), 'email', 'the check would have caught it');
  assert.throws(() => env.DB._sqlite.prepare(
    "INSERT INTO clippers (username, password_hash, password_salt, status, created_at, email_key) VALUES ('racer', 'h', 's', 'active', ?, ?)").run(NOW, keys.email_key),
    e => duplicateField(e) === 'email');
});

/* ------------------------------------------------ the profile and the admin */

function profileWorld() {
  const c = (id, username, email, phone, discord) => ({
    id, username, password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW,
    ...COMPLETE_PROFILE, email, contact_number: phone, discord_username: discord,
    ...identityKeys({ email, contact_number: phone, discord_username: discord })
  });
  return { DB: makeSqliteD1({ clippers: [
    c(1, 'ravi', 'ravi@gmail.com', '9876543210', 'ravi.k'),
    c(2, 'asha', 'asha@example.in', '9123456780', 'asha_n')
  ] }), SESSION_SECRET: SECRET, ADMIN_PASSWORD: 'x' };
}
const FORM = { email: 'asha@example.in', contactNumber: '9123456780', upiId: 'asha@okbank', accountName: 'Asha Nair', legalName: 'Asha Nair', discordUsername: 'asha_n' };
async function saveProfile(env, id, patch) {
  const cookie = await createSessionCookie('clipper', id, SECRET);
  const req = new Request('https://clipgrow.in/api/clipper/me/profile', {
    method: 'PATCH', headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' }, body: JSON.stringify({ ...FORM, ...patch })
  });
  return handleClipper(req, env, new URL(req.url));
}

test('saving your own profile with what you already have is fine', async () => {
  assert.equal((await saveProfile(profileWorld(), 2, {})).status, 200);
});

test('changing your details to someone else\'s is refused, and nothing is saved', async () => {
  for (const [field, patch] of [
    ['email', { email: 'r.a.v.i+x@gmail.com' }],
    ['phone', { contactNumber: '+91 98765 43210' }],
    ['discord', { discordUsername: '@RAVI.K' }]
  ]) {
    const env = profileWorld();
    const res = await saveProfile(env, 2, patch);
    assert.equal(res.status, 409, field);
    assert.equal((await res.json()).field, field);
    const r = env.DB._sqlite.prepare('SELECT email, contact_number, discord_username FROM clippers WHERE id = 2').get();
    assert.deepEqual([r.email, r.contact_number, r.discord_username], ['asha@example.in', '9123456780', 'asha_n'], 'unchanged');
  }
});

test('a real change is saved along with its new keys, and frees the old ones', async () => {
  const env = profileWorld();
  assert.equal((await saveProfile(env, 2, { email: 'a.sha@gmail.com' })).status, 200);
  assert.equal(env.DB._sqlite.prepare('SELECT email_key FROM clippers WHERE id = 2').get().email_key, 'asha@gmail.com');
  // Her old address is free for someone else now.
  assert.equal(await identityConflict(env.DB, identityKeys({ email: 'asha@example.in' })), null);
});

async function adminEdit(env, id, body) {
  const cookie = await createSessionCookie('admin', 0, SECRET);
  const req = new Request(`https://clipgrow.in/api/admin/clippers/${id}`, {
    method: 'PATCH', headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return handleAdmin(req, env, new URL(req.url));
}

test('the admin cannot give one clipper another\'s email, number or Discord either', async () => {
  for (const [field, body] of [['email', { email: 'RAVI@gmail.com' }], ['phone', { contact_number: '9876543210' }], ['discord', { discord_username: 'ravi.k' }]]) {
    const env = profileWorld();
    const res = await adminEdit(env, 2, body);
    assert.equal(res.status, 409, field);
    assert.match((await res.json()).error, /already used by another ClipGrow account/);
  }
});

test('an admin edit that is fine updates the value and its key together', async () => {
  const env = profileWorld();
  assert.equal((await adminEdit(env, 2, { email: 'asha.new@example.in', contact_number: '+91 91234 56781', discord_username: '@Asha_New' })).status, 200);
  const r = env.DB._sqlite.prepare('SELECT * FROM clippers WHERE id = 2').get();
  assert.deepEqual([r.email_key, r.phone_key, r.discord_key], ['asha.new@example.in', '9123456781', 'asha_new']);
  assert.equal(r.contact_number, '9123456781', 'stored in one form only');
});

test('restoring an archived account whose email has been taken since says so instead of failing', async () => {
  const env = { ...profileWorld(), CLIPPER_SIGNUP: 'open' };
  // Asha is archived, then a new person signs up with her old email.
  const cookie = await createSessionCookie('admin', 0, SECRET);
  const del = new Request('https://clipgrow.in/api/admin/clippers/2', { method: 'DELETE', headers: { Cookie: cookie.split(';')[0] } });
  assert.equal((await handleAdmin(del, env, new URL(del.url))).status, 200, 'archived the way the admin does it');
  const made = await signup(env, { username: 'newcomer', password: 'correct-horse-9', email: 'asha@example.in', contactNumber: '9000000002', discordUsername: 'newcomer_d' });
  assert.equal(made.status, 201, 'the archived account\x27s email is free for a new person');
  const res = await adminEdit(env, 2, { status: 'active' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /cannot be restored/);
  assert.equal(env.DB._sqlite.prepare('SELECT status FROM clippers WHERE id = 2').get().status, 'deleted');
});

/* ---------------------------------------------- linking Discord never fails */

test('linking Discord still works when another account typed the same name into its profile', async () => {
  const env = {
    ...profileWorld(),
    DISCORD_CLIENT_ID: '111', DISCORD_CLIENT_SECRET: 's', DISCORD_BOT_TOKEN: 't', DISCORD_GUILD_ID: '999', DISCORD_LINK: 'optional'
  };
  globalThis.fetch = async input => {
    const url = String(input);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/oauth2/token')) return json({ access_token: 'user-token' });
    if (url.endsWith('/users/@me')) return json({ id: '5550001', username: 'ravi.k', global_name: 'Ravi' });   // "ravi.k" is account 1's typed name
    if (url.includes('/guilds/999/members/')) return new Response(null, { status: 204 });
    return json({}, 404);
  };
  const state = await signSession({ sub: 2, purpose: 'discord', campaign_id: null, exp: Date.now() + 60000 }, SECRET);
  const cookie = await createSessionCookie('clipper', 2, SECRET);
  const req = new Request(`https://clipgrow.in/api/auth/discord/callback?code=abc&state=${encodeURIComponent(state)}`, { headers: { Cookie: cookie.split(';')[0] } });
  const res = await handleDiscordAuth(req, env, new URL(req.url));
  assert.equal(res.status, 302);
  const r = env.DB._sqlite.prepare('SELECT discord_user_id, discord_username FROM clippers WHERE id = 2').get();
  assert.equal(r.discord_user_id, '5550001', 'the verified link stands');
  assert.equal(r.discord_username, 'asha_n', 'and the typed name is left alone rather than colliding');
});

/* ------------------------------------------------------ nothing bypasses it */

// The keys are only as good as every write that touches the details they describe.
// A future route that updates an email and forgets its key would quietly open a
// hole, so this reads the source: any UPDATE of these columns must set the key too.
test('every statement that changes an email, number or Discord username also changes its key', () => {
  const files = [];
  const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') && files.push(p); } };
  walk(new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const need = [['email', 'email_key'], ['contact_number', 'phone_key'], ['discord_username', 'discord_key']];
  let checked = 0;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/UPDATE clippers SET([\s\S]*?)WHERE/g)) {
      const set = m[1];
      for (const [col, key] of need) {
        if (new RegExp(`(^|[\\s,])${col}\\s*=`).test(set)) { checked++; assert.ok(set.includes(key), `${f}: sets ${col} without ${key}:\n${set.trim()}`); }
      }
    }
  }
  assert.ok(checked >= 5, `expected to find the known writers, found ${checked}`);
});

test('the sign-up form asks for each detail and shows the server\'s message under the right box', () => {
  const html = readFileSync(new URL('../login.html', import.meta.url), 'utf8');
  for (const id of ['su-email', 'su-phone', 'su-discord', 'su-e-email', 'su-e-phone', 'su-e-discord']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /contactNumber:\s*\$\('su-phone'\)/);
  assert.match(html, /body\.field/);
});
