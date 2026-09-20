// Every clipper must have proper contact and payout details on file.
//
// Three things are pinned here: the field rules themselves (one file, shared
// by the server and the dashboard form), that a clipper who entered details
// under the old looser rules is brought up to standard, and that the server
// refuses to start anything new for an incomplete profile even if the
// dashboard is bypassed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleClipper } from '../src/routes/clipper.js';
import { createSessionCookie } from '../src/auth.js';
import { COMPLETE_PROFILE } from './helpers/profile.mjs';
import {
  validateEmail, validateContactNumber, validateUpiId, validatePersonName,
  validateDiscordUsername, normaliseName, profileProblems, profileComplete
} from '../components/profile-validation.js';

const ok = v => assert.equal(v, null);
const bad = (v, re) => { assert.equal(typeof v, 'string'); if (re) assert.match(v, re); };

test('email: real shapes pass, malformed and mistyped ones do not', () => {
  for (const good of ['a@b.co', 'first.last+tag@sub.example.in', 'RAVI_99@Gmail.com']) ok(validateEmail(good));
  for (const nope of ['', 'plain', 'a@', '@b.com', 'a@b', 'a b@c.com', 'a..b@c.com', '.a@c.com', 'a.@c.com', 'a@-b.com', 'a@b.c', 'a@b..com']) {
    bad(validateEmail(nope));
  }
  bad(validateEmail('ravi@gmial.com'), /gmail\.com/);
  bad(validateEmail('ravi@gmail.con'), /gmail\.com/);
});

test('contact number: 10-digit Indian mobiles in any common format, not placeholders', () => {
  for (const good of ['9876543210', '+91 98765 43210', '098765 43210', '91-98765-43210']) ok(validateContactNumber(good));
  for (const nope of ['', '12345', '5876543210', '98765432101', 'abcdefghij']) bad(validateContactNumber(nope));
  bad(validateContactNumber('9999999999'), /placeholder/);
  bad(validateContactNumber('7777777777'), /placeholder/);
});

test('UPI id: handle@bank shape, never checked against a list of banks', () => {
  for (const good of ['9876543210@upi', 'ravi.kumar@oksbi', 'r_k-99@ybl', 'name@someNewBank']) ok(validateUpiId(good));
  for (const nope of ['', 'noatsign', 'a@b', '@upi', 'ravi@', 'ravi@bank1', '-ravi@upi', 'r@upi']) bad(validateUpiId(nope));
});

test('names: real people\'s names in any script, nothing else', () => {
  for (const good of ['Ravi Kumar', "D'Souza", 'Anne-Marie', 'K. S. Nair', 'राहुल शर्मा', 'ரவி', 'Priya']) ok(validatePersonName(good, 'name'));
  for (const nope of ['', 'A', '.', '12345', 'Ravi123', 'Ravi @ home', '😀😀', '- -', 'x'.repeat(101)]) bad(validatePersonName(nope, 'name'));
  assert.equal(normaliseName('  Ravi    Kumar '), 'Ravi Kumar');
});

test('discord: lowercase username shape', () => {
  ok(validateDiscordUsername('ravi.k_99'));
  ok(validateDiscordUsername('@Ravi'));   // a pasted @ is fine
  bad(validateDiscordUsername('r'));
  bad(validateDiscordUsername('has space'));
  bad(validateDiscordUsername('.dot'));
  bad(validateDiscordUsername('a..b'));
});

test('an empty profile lists every field; a complete one lists none', () => {
  assert.equal(profileProblems({}).length, 6);
  assert.deepEqual(profileProblems(COMPLETE_PROFILE), []);
  assert.equal(profileComplete(COMPLETE_PROFILE), true);
});

test('details that were fine under the old looser rules are flagged for correction', () => {
  // Accepted before: a name with digits, a placeholder number. Both must now be fixed.
  const old = { ...COMPLETE_PROFILE, legal_name: 'Ravi 123', contact_number: '9999999999' };
  const problems = profileProblems(old).map(p => p.key).sort();
  assert.deepEqual(problems, ['contact_number', 'legal_name']);
});

/* ------------------------------------------------------------- the routes */

const NOW = Date.now();
const SECRET = 'test-secret';

function world(clipperExtra = {}) {
  return {
    DB: makeSqliteD1({
      clippers: [{ id: 1, username: 'c1', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW, ...clipperExtra }],
      campaigns: [{ id: 1, name: 'C', description: '', cpm: 40, budget: 100000, status: 'active', created_at: NOW,
                    model: 'cpm', min_views: 0, allowed_platforms: 'instagram' }],
      participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW }]
    }),
    SESSION_SECRET: SECRET
  };
}

async function call(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('clipper', 1, SECRET);
  const req = new Request(`https://clipgrow.in${path}`, {
    method, headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleClipper(req, env, new URL(req.url));
}

test('/me tells the dashboard exactly what is missing', async () => {
  const env = world({ email: 'a@b.co' });
  const me = (await (await call(env, '/api/clipper/me')).json()).clipper;
  assert.equal(me.profile_complete, false);
  assert.deepEqual(me.profile_problems.map(p => p.key).sort(),
    ['contact_number', 'discord_username', 'legal_name', 'upi_account_name', 'upi_id']);
});

test('the server refuses to start anything new until the profile is complete', async () => {
  const env = world();   // no details at all
  const gated = [
    ['/api/clipper/campaigns/1/join', {}],
    ['/api/clipper/campaigns/1/applications', { video_url: 'https://drive.google.com/file/d/x/view' }],
    ['/api/clipper/campaigns/1/applications/upload-url', { mime_type: 'video/mp4', size_bytes: 1000 }],
    ['/api/clipper/access-request', { campaign_id: 1, platform: 'instagram', identifier: 'my.handle' }]
  ];
  for (const [path, body] of gated) {
    const res = await call(env, path, { method: 'POST', body });
    assert.equal(res.status, 403, `${path} must be refused`);
    assert.match((await res.json()).error, /complete your details/i);
  }
});

test('reading earnings and the profile itself are never blocked', async () => {
  const env = world();
  assert.equal((await call(env, '/api/clipper/me')).status, 200);
  assert.equal((await call(env, '/api/clipper/campaigns')).status, 200);
});

test('once the profile is complete the same actions go through', async () => {
  const env = world(COMPLETE_PROFILE);
  const res = await call(env, '/api/clipper/campaigns/1/applications', { method: 'POST', body: { video_url: 'https://drive.google.com/file/d/x/view' } });
  assert.equal(res.status, 201);
});

test('saving the profile enforces every rule, and stores the clean values', async () => {
  const env = world();
  const body = {
    email: ' Ravi.K@Example.COM ', contactNumber: '+91 98765 43210', upiId: 'ravi.k@oksbi',
    accountName: '  Ravi   Kumar ', legalName: 'Ravi Kumar', discordUsername: '@Ravi.K'
  };
  // each bad field is refused with its own message and nothing is saved
  for (const [k, v] of [['email', 'nope'], ['contactNumber', '9999999999'], ['upiId', 'nope'],
                        ['accountName', 'R2D2'], ['legalName', '1'], ['discordUsername', '']]) {
    const res = await call(env, '/api/clipper/me/profile', { method: 'PATCH', body: { ...body, [k]: v } });
    assert.equal(res.status, 400, `${k} = ${JSON.stringify(v)} must be refused`);
  }
  assert.equal(env.DB._sqlite.prepare('SELECT email FROM clippers WHERE id = 1').get().email, null, 'a refused save writes nothing');

  const res = await call(env, '/api/clipper/me/profile', { method: 'PATCH', body });
  assert.equal(res.status, 200);
  const row = env.DB._sqlite.prepare('SELECT * FROM clippers WHERE id = 1').get();
  assert.equal(row.email, 'ravi.k@example.com');
  assert.equal(row.contact_number, '9876543210');
  assert.equal(row.upi_account_name, 'Ravi Kumar', 'whitespace collapsed');
  assert.equal(row.discord_username, 'ravi.k');
  assert.equal(profileComplete(row), true);
});
