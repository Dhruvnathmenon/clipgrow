// Self-serve clipper sign-up. Until now an admin created every account by hand;
// this lets a person create their own, which makes it the first place an
// anonymous visitor can make ClipGrow write a row -- hence a switch (off by
// default), validation shared with the form, and a brake on floods.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleClipper } from '../src/routes/clipper.js';
import { verifyPassword } from '../src/auth.js';
import { signupOpen, LIMITS } from '../src/signup.js';
import { validateUsername, validatePassword } from '../components/account-validation.js';

const SECRET = 'test-secret';

function world({ open = true } = {}) {
  return { DB: makeSqliteD1({}), SESSION_SECRET: SECRET, ...(open ? { CLIPPER_SIGNUP: 'open' } : {}) };
}

async function call(env, path, { method = 'GET', body, ip = '203.0.113.7', cookie } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip };
  if (cookie) headers.Cookie = cookie;
  const request = new Request(`https://clipgrow.in${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return handleClipper(request, env, new URL(request.url));
}
// Every sign-up needs an email, a phone number and a Discord username, each one
// account only (see one-account-per-person.test.mjs). These tests are about the
// switch, the limits and the credentials, so unless a test says otherwise each
// call gets details of its own and can never collide with another.
let serial = 0;
const uniqueDetails = () => {
  serial++;
  return { email: `person${serial}@example.com`, contactNumber: `98765${String(10000 + serial)}`, discordUsername: `person_${serial}` };
};
const signup = (env, body, opts) => call(env, '/api/clipper/signup', { method: 'POST', body: { ...uniqueDetails(), ...body }, ...opts });
const clippers = env => env.DB._sqlite.prepare('SELECT * FROM clippers').all();
const GOOD = { username: 'ravi.kumar', password: 'correct-horse-9' };

/* ------------------------------------------------------------------ switch */

test('closed: the form is not offered and nothing can be created', async () => {
  const env = world({ open: false });
  assert.equal(signupOpen(env), false);
  assert.deepEqual(await (await call(env, '/api/clipper/signup')).json(), { open: false });
  const res = await signup(env, GOOD);
  assert.equal(res.status, 403);
  assert.equal(clippers(env).length, 0);
});

test('only the exact word "open" opens it', () => {
  for (const v of [undefined, '', 'off', 'on', 'true', '1', 'yes']) assert.equal(signupOpen({ CLIPPER_SIGNUP: v }), false, String(v));
  assert.equal(signupOpen({ CLIPPER_SIGNUP: 'open' }), true);
  assert.equal(signupOpen({ CLIPPER_SIGNUP: 'OPEN' }), true);
});

/* ------------------------------------------------------------ happy path */

test('open: creates the account, signs them in, and stores a hash, never the password', async () => {
  const env = world();
  assert.deepEqual(await (await call(env, '/api/clipper/signup')).json(), { open: true });

  const res = await signup(env, GOOD);
  assert.equal(res.status, 201);
  const cookie = res.headers.get('Set-Cookie');
  assert.match(cookie, /cg_session=/);

  const [row] = clippers(env);
  assert.equal(row.username, 'ravi.kumar');
  assert.equal(row.display_name, 'Ravi.kumar');
  assert.equal(row.status, 'active');
  assert.equal(row.created_by_type, 'self', 'attributed to the person, not to an admin');
  assert.notEqual(row.password_hash, GOOD.password);
  assert.equal(await verifyPassword(GOOD.password, row.password_hash, row.password_salt), true);

  // The cookie it hands back is a working session.
  const me = await call(env, '/api/clipper/me', { cookie: cookie.split(';')[0] });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).clipper.username, 'ravi.kumar');
});

test('the new account can log in with the same details afterwards', async () => {
  const env = world();
  await signup(env, GOOD);
  const ok = await call(env, '/api/clipper/login', { method: 'POST', body: { username: 'Ravi.Kumar', password: GOOD.password } });
  assert.equal(ok.status, 200, 'the username is case-insensitive on the way in');
  const bad = await call(env, '/api/clipper/login', { method: 'POST', body: { username: 'ravi.kumar', password: 'wrong-password-1' } });
  assert.equal(bad.status, 401);
});

test('a brand-new account cannot start anything until it completes its details', async () => {
  const env = world();
  const cookie = (await signup(env, GOOD)).headers.get('Set-Cookie').split(';')[0];
  env.DB._sqlite.prepare("INSERT INTO campaigns (id, name, description, cpm, budget, status, created_at, model, min_views, allowed_platforms) VALUES (1, 'C', '', 40, 1000, 'active', 1, 'cpm', 0, 'instagram')").run();
  const res = await call(env, '/api/clipper/campaigns/1/join', { method: 'POST', body: {}, cookie });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /complete your details/i);
});

/* ------------------------------------------------------------ validation */

test('usernames: what is accepted and what is not', () => {
  for (const good of ['ravi', 'ravi.kumar', 'r_k-99', 'RAVI99', 'a1b']) assert.equal(validateUsername(good), null, good);
  const bad = ['', '  ', 'ab', 'x'.repeat(25), 'has space', 'a b', '.ravi', 'ravi.', '-ravi', 'ra..vi', 'ra__vi', 'ravi!', 'rávi', 'ravi@x', 'admin', 'ClipGrow', 'Support'];
  for (const b of bad) assert.equal(typeof validateUsername(b), 'string', JSON.stringify(b));
});

test('passwords: length, the obvious ones, and not the username', () => {
  assert.equal(validatePassword('correct-horse-9', 'ravi'), null);
  assert.equal(validatePassword('ab'.repeat(64), 'ravi'), null, 'exactly the maximum length is allowed');
  const bad = ['', 'short7!', 'a'.repeat(129), 'aaaaaaaa', '11111111', 'password', 'Password123', '12345678', 'qwertyuiop', 'ClipGrow123'];
  for (const b of bad) assert.equal(typeof validatePassword(b, 'ravi'), 'string', JSON.stringify(b));
  assert.equal(typeof validatePassword('ravi.kumar', 'Ravi.Kumar'), 'string', 'not the username, whatever the case');
});

test('the route applies the same rules and writes nothing on a refusal', async () => {
  const env = world();
  for (const body of [
    { username: 'ab', password: GOOD.password }, { username: 'has space', password: GOOD.password },
    { username: 'admin', password: GOOD.password }, { username: 'ravi', password: 'short' },
    { username: 'ravi', password: 'password123' }, { username: 'ravi', password: 'ravi' }, {}
  ]) {
    const res = await signup(env, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(typeof (await res.json()).error, 'string');
  }
  assert.equal(clippers(env).length, 0);
});

/* ------------------------------------------------------------ uniqueness */

test('a taken username is refused whatever the case, and does not use up the limit', async () => {
  const env = world();
  await signup(env, GOOD);
  for (const u of ['ravi.kumar', 'RAVI.KUMAR', ' Ravi.Kumar ']) {
    const res = await signup(env, { username: u, password: 'another-pass-77' });
    assert.equal(res.status, 409, u);
  }
  assert.equal(clippers(env).length, 1);
  assert.equal(env.DB._sqlite.prepare('SELECT COUNT(*) n FROM signup_attempts').get().n, 1, 'only the created account counts');
});

test('the unique index is the backstop when two people pick a name at once', () => {
  const env = world();
  const ins = () => env.DB._sqlite.prepare("INSERT INTO clippers (username, password_hash, password_salt, status, created_at) VALUES ('same', 'h', 's', 'active', 1)").run();
  ins();
  assert.throws(ins, /UNIQUE/i);
});

/* ------------------------------------------------------------- the brake */

test('a filled-in honeypot is refused without creating anything', async () => {
  const env = world();
  const res = await signup(env, { ...GOOD, website: 'http://spam.example' });
  assert.equal(res.status, 400);
  assert.equal(clippers(env).length, 0);
});

test('one address is limited per hour, another address is not', async () => {
  const env = world();
  for (let i = 0; i < LIMITS.perIpHour; i++) {
    const res = await signup(env, { username: `person${i}`, password: 'correct-horse-9' }, { ip: '198.51.100.1' });
    assert.equal(res.status, 201, `sign-up ${i + 1}`);
  }
  const over = await signup(env, { username: 'onetoomany', password: 'correct-horse-9' }, { ip: '198.51.100.1' });
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get('Retry-After')) > 0);
  assert.equal(clippers(env).some(c => c.username === 'onetoomany'), false);

  const other = await signup(env, { username: 'someoneelse', password: 'correct-horse-9' }, { ip: '198.51.100.2' });
  assert.equal(other.status, 201, 'a different address is unaffected');
});

test('the limit lifts as the hour passes', async () => {
  const env = world();
  const old = Date.now() - 2 * 60 * 60 * 1000;
  const { hashIp } = await import('../src/signup.js');
  const h = await hashIp('198.51.100.9', SECRET);
  for (let i = 0; i < LIMITS.perIpHour; i++) env.DB._sqlite.prepare('INSERT INTO signup_attempts (ip_hash, created_at) VALUES (?, ?)').run(h, old);
  const res = await signup(env, GOOD, { ip: '198.51.100.9' });
  assert.equal(res.status, 201, 'sign-ups from two hours ago no longer count against the hour');
});

test('a site-wide surge shuts the door for everyone, briefly', async () => {
  const env = world();
  const recent = Date.now() - 60 * 1000;
  for (let i = 0; i < LIMITS.globalHour; i++) env.DB._sqlite.prepare('INSERT INTO signup_attempts (ip_hash, created_at) VALUES (?, ?)').run(`h${i}`, recent);
  const res = await signup(env, GOOD, { ip: '192.0.2.44' });
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /signing up right now/i);
});

test('the address is never stored, only a salted hash of it', async () => {
  const env = world();
  await signup(env, GOOD, { ip: '203.0.113.99' });
  const rows = env.DB._sqlite.prepare('SELECT * FROM signup_attempts').all();
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes('203.0.113.99'), false);
  assert.match(rows[0].ip_hash, /^[0-9a-f]{32}$/);
});

test('old attempt rows are pruned as new ones are written', async () => {
  const env = world();
  env.DB._sqlite.prepare('INSERT INTO signup_attempts (ip_hash, created_at) VALUES (?, ?)').run('ancient', Date.now() - 5 * 24 * 60 * 60 * 1000);
  await signup(env, GOOD);
  assert.equal(env.DB._sqlite.prepare("SELECT COUNT(*) n FROM signup_attempts WHERE ip_hash = 'ancient'").get().n, 0);
});
