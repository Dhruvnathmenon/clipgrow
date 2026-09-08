// A clipper's contact profile (legal name, contact number, email) --
// migration 030, admin-only for now (clipper self-service lands in a later
// phase). Same admin+clipper-only boundary as UPI (migration 028,
// test/clipper-upi.test.mjs), so this file mirrors that one's structure:
// the privacy-boundary test at the bottom is what actually proves a
// moderator session can never see these fields, not just a comment saying so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleAdmin } from '../src/routes/admin.js';
import { handleModerator } from '../src/routes/moderator.js';
import { createSessionCookie } from '../src/auth.js';
import {
  normaliseContactNumber, validateContactNumber, normaliseEmail, validateEmail,
  normaliseDiscordId, validateDiscordId
} from '../src/db.js';

const NOW = Date.now();
const SESSION_SECRET = 'test-secret';

function seedEnv() {
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'clipper1', password_hash: 'h', password_salt: 's',
                 status: 'active', created_at: NOW }],
    moderators: [{ id: 1, username: 'jane', password_hash: 'h', password_salt: 's',
                   display_name: 'Jane', status: 'active', created_at: NOW }]
  });
  return { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
}

async function adminRequest(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('admin', 'admin', env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method,
    headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleAdmin(request, env, new URL(request.url));
}

async function moderatorRequest(env, path) {
  const cookie = await createSessionCookie('moderator', 1, env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method: 'GET', headers: { Cookie: cookie.split(';')[0] }
  });
  return handleModerator(request, env, new URL(request.url));
}

/* ── validators ── */

test('validateContactNumber accepts real-shaped Indian mobile numbers in any common format', () => {
  assert.equal(validateContactNumber('9876543210'), null);
  assert.equal(validateContactNumber('+91 98765 43210'), null);
  assert.equal(validateContactNumber('098765 43210'), null);
  assert.equal(validateContactNumber(''), 'Enter a contact number');
  assert.ok(validateContactNumber('12345'), 'too short');
  assert.ok(validateContactNumber('1234567890'), "doesn't start 6-9");
});

test('normaliseContactNumber collapses +91 / leading-0 / plain forms to the same 10 digits', () => {
  assert.equal(normaliseContactNumber('+91 98765 43210'), '9876543210');
  assert.equal(normaliseContactNumber('098765 43210'), '9876543210');
  assert.equal(normaliseContactNumber('9876543210'), '9876543210');
});

test('validateEmail accepts real-shaped addresses and rejects obvious junk', () => {
  assert.equal(validateEmail('ravi@example.com'), null);
  assert.equal(validateEmail(''), 'Enter an email address');
  assert.ok(validateEmail('not-an-email'), 'no @ at all');
  assert.ok(validateEmail('ravi@nodot'), 'no dot in domain');
});

test('normaliseEmail trims and lowercases', () => {
  assert.equal(normaliseEmail('  Ravi@Example.COM '), 'ravi@example.com');
});

test('validateDiscordId accepts a real numeric snowflake and an empty value, rejects a username', () => {
  assert.equal(validateDiscordId('305421934793015296'), null, 'a real 18-digit snowflake');
  assert.equal(validateDiscordId(''), null, 'optional -- empty is not an error');
  assert.equal(validateDiscordId(null), null, 'optional -- null is not an error');
  assert.ok(validateDiscordId('clipgrow_fan_92'), 'a username, not the numeric id');
  assert.ok(validateDiscordId('123'), 'too short to be a real snowflake');
});

test('normaliseDiscordId strips everything but digits', () => {
  assert.equal(normaliseDiscordId(' 305421934793015296 '), '305421934793015296');
  assert.equal(normaliseDiscordId('id:305421934793015296'), '305421934793015296');
});

/* ── admin visibility + edit ── */

test('the admin roster includes the contact profile', async () => {
  const env = seedEnv();
  await env.DB.prepare(
    "UPDATE clippers SET contact_number = '9876543210', email = 'ravi@example.com', legal_name = 'Ravi Kumar Singh' WHERE id = 1"
  ).run();
  const { clippers } = await (await adminRequest(env, '/api/admin/clippers')).json();
  assert.equal(clippers[0].contact_number, '9876543210');
  assert.equal(clippers[0].email, 'ravi@example.com');
  assert.equal(clippers[0].legal_name, 'Ravi Kumar Singh');
});

test('the admin clipper detail includes the contact profile', async () => {
  const env = seedEnv();
  await env.DB.prepare(
    "UPDATE clippers SET contact_number = '9876543210', email = 'ravi@example.com', legal_name = 'Ravi Kumar Singh' WHERE id = 1"
  ).run();
  const { clipper } = await (await adminRequest(env, '/api/admin/clippers/1')).json();
  assert.equal(clipper.contact_number, '9876543210');
  assert.equal(clipper.email, 'ravi@example.com');
  assert.equal(clipper.legal_name, 'Ravi Kumar Singh');
});

test('a clipper with no contact profile on file sees null fields, not missing ones', async () => {
  const env = seedEnv();
  const { clipper } = await (await adminRequest(env, '/api/admin/clippers/1')).json();
  assert.equal(clipper.contact_number, null);
  assert.equal(clipper.email, null);
  assert.equal(clipper.legal_name, null);
});

test('the admin can set the contact profile through the same Edit action as username/password/UPI', async () => {
  const env = seedEnv();
  const res = await adminRequest(env, '/api/admin/clippers/1', {
    method: 'PATCH', body: { contact_number: '+91 98765 43210', email: 'Ravi@Example.com', legal_name: 'Ravi Kumar Singh' }
  });
  assert.equal(res.status, 200);
  const row = await env.DB.prepare('SELECT contact_number, email, legal_name FROM clippers WHERE id = 1').first();
  assert.equal(row.contact_number, '9876543210', 'normalised to plain 10 digits');
  assert.equal(row.email, 'ravi@example.com', 'normalised to lowercase');
  assert.equal(row.legal_name, 'Ravi Kumar Singh');
});

test('the admin edit rejects an invalid contact number before it reaches the database', async () => {
  const env = seedEnv();
  const res = await adminRequest(env, '/api/admin/clippers/1', {
    method: 'PATCH', body: { contact_number: '12345' }
  });
  assert.equal(res.status, 400);
  const row = await env.DB.prepare('SELECT contact_number FROM clippers WHERE id = 1').first();
  assert.equal(row.contact_number, null);
});

test('the admin edit rejects an invalid email before it reaches the database', async () => {
  const env = seedEnv();
  const res = await adminRequest(env, '/api/admin/clippers/1', {
    method: 'PATCH', body: { email: 'not-an-email' }
  });
  assert.equal(res.status, 400);
  const row = await env.DB.prepare('SELECT email FROM clippers WHERE id = 1').first();
  assert.equal(row.email, null);
});

test('legal_name has no shape validator -- any non-empty trimmed text is accepted', async () => {
  const env = seedEnv();
  const res = await adminRequest(env, '/api/admin/clippers/1', {
    method: 'PATCH', body: { legal_name: '  Ravi Kumar Singh  ' }
  });
  assert.equal(res.status, 200);
  const row = await env.DB.prepare('SELECT legal_name FROM clippers WHERE id = 1').first();
  assert.equal(row.legal_name, 'Ravi Kumar Singh');
});

/* ── Discord (migration 035) ── */

test('the admin roster and detail include the Discord id', async () => {
  const env = seedEnv();
  await env.DB.prepare("UPDATE clippers SET discord_id = '305421934793015296' WHERE id = 1").run();
  const { clippers } = await (await adminRequest(env, '/api/admin/clippers')).json();
  assert.equal(clippers[0].discord_id, '305421934793015296');
  const { clipper } = await (await adminRequest(env, '/api/admin/clippers/1')).json();
  assert.equal(clipper.discord_id, '305421934793015296');
});

test('the admin can set a Discord id through the same Edit action as everything else', async () => {
  const env = seedEnv();
  const res = await adminRequest(env, '/api/admin/clippers/1', {
    method: 'PATCH', body: { discord_id: '305421934793015296' }
  });
  assert.equal(res.status, 200);
  const row = await env.DB.prepare('SELECT discord_id FROM clippers WHERE id = 1').first();
  assert.equal(row.discord_id, '305421934793015296');
});

test('the admin edit rejects a Discord username the same way the clipper endpoint does', async () => {
  const env = seedEnv();
  const res = await adminRequest(env, '/api/admin/clippers/1', {
    method: 'PATCH', body: { discord_id: 'clipgrow_fan_92' }
  });
  assert.equal(res.status, 400);
  const row = await env.DB.prepare('SELECT discord_id FROM clippers WHERE id = 1').first();
  assert.equal(row.discord_id, null);
});

/* ── the actual privacy boundary ── */

test('a moderator can never see a clipper contact profile, in the roster or the detail view', async () => {
  const env = seedEnv();
  await env.DB.prepare(
    "UPDATE clippers SET contact_number = '9876543210', email = 'ravi@example.com', legal_name = 'Ravi Kumar Singh', discord_id = '305421934793015296' WHERE id = 1"
  ).run();

  const roster = await (await moderatorRequest(env, '/api/moderator/clippers')).json();
  assert.equal(roster.clippers[0].contact_number, undefined);
  assert.equal(roster.clippers[0].email, undefined);
  assert.equal(roster.clippers[0].legal_name, undefined);
  assert.equal(roster.clippers[0].discord_id, undefined);

  const detail = await (await moderatorRequest(env, '/api/moderator/clippers/1')).json();
  assert.equal(detail.clipper.contact_number, undefined);
  assert.equal(detail.clipper.email, undefined);
  assert.equal(detail.clipper.legal_name, undefined);
  assert.equal(detail.clipper.discord_id, undefined);
});
