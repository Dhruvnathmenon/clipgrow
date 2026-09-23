// How an account ends: the clipper's own deletion, and the clean-up of accounts
// that were made and never used.
//
// The clean-up is the dangerous half -- it deletes people -- so most of this file
// is about what it must NOT do: touch anyone who has done anything, delete someone
// we could not warn, or act on a warning that a later visit made stale.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleClipper } from '../src/routes/clipper.js';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie, hashPassword } from '../src/auth.js';
import {
  dormantAccounts, runDormantSweep, archiveClipper, selfDeleteBlockers, touchLastSeen,
  DORMANT_AFTER_MS, GRACE_MS, SEEN_EVERY_MS
} from '../src/account-lifecycle.js';
import { COMPLETE_PROFILE } from './helpers/profile.mjs';
import { identityKeys } from '../src/identity.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const LONG_AGO = NOW - 45 * DAY;
const SECRET = 'test-secret';
const DISCORD_ENV = { DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 's', DISCORD_BOT_TOKEN: 't', DISCORD_GUILD_ID: 'g' };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Discord's two REST calls, recorded. `dmOk` false plays someone with DMs closed.
function fakeDiscord({ dmOk = true } = {}) {
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/users/@me/channels')) {
      const { recipient_id } = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: `dm-${recipient_id}` }), { status: 200 });
    }
    if (/\/channels\/dm-.+\/messages$/.test(String(url))) {
      if (!dmOk) return new Response(JSON.stringify({ code: 50007 }), { status: 403 });
      sent.push({ to: String(url).match(/dm-(.+)\/messages/)[1], text: JSON.parse(init.body).content });
      return new Response('{}', { status: 200 });
    }
    throw new Error('unexpected fetch ' + url);
  };
  return sent;
}

const clipper = (id, extra = {}) => ({
  id, username: `c${id}`, password_hash: 'h', password_salt: 's', status: 'active', created_at: LONG_AGO,
  last_seen_at: LONG_AGO, ...COMPLETE_PROFILE,
  // Each fixture clipper needs keys of its own: they are held unique across accounts.
  email_key: `e${id}@example.com`, phone_key: `9${String(id).padStart(9, '0')}`, discord_key: `d${id}`,
  ...extra
});

function world(extra = {}) {
  return makeSqliteD1({
    clippers: [clipper(1, { discord_user_id: '111' })],
    campaigns: [{ id: 1, name: 'C', description: '', cpm: 40, budget: 100000, status: 'active', created_at: NOW,
                  model: 'cpm', min_views: 0, allowed_platforms: 'instagram' }],
    ...extra
  });
}
const env = db => ({ DB: db, SESSION_SECRET: SECRET, ADMIN_PASSWORD: 'x', ...DISCORD_ENV });

/* --------------------------------------------------- who counts as unused */

test('a made-and-never-used account that nobody has opened in a month is unused', async () => {
  const rows = await dormantAccounts(world(), NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'unwarned');
});

test('anyone who has done anything is never unused', async () => {
  const doneSomething = {
    'a connected account': { social_accounts: [{ id: 1, clipper_id: 1, platform: 'instagram', external_id: 'x', username: 'a', status: 'connected', connected_at: NOW }] },
    'a video in review': { campaign_applications: [{ id: 1, clipper_id: 1, campaign_id: 1, attempt: 1, status: 'pending', created_at: NOW }] },
    'an approved video': { campaign_applications: [{ id: 1, clipper_id: 1, campaign_id: 1, attempt: 1, status: 'approved', created_at: NOW }] },
    'an account request in flight': { tester_requests: [{ id: 1, clipper_id: 1, ig_username: 'a', status: 'requested', campaign_id: 1, requested_at: NOW, platform: 'instagram', identifier: 'a' }] },
    'a payment': { payments: [{ id: 1, clipper_id: 1, amount: 100, paid_at: NOW, created_at: NOW }] },
    'a clip': { submissions: [{ id: 1, clipper_id: 1, campaign_id: 1, platform: 'instagram', ig_media_id: 'm', permalink: 'p', views: 1, earning: 0, status: 'active', eligible: 1, created_at: NOW, posted_at: NOW }] }
  };
  for (const [what, fixture] of Object.entries(doneSomething)) {
    assert.equal((await dormantAccounts(world(fixture), NOW)).length, 0, `not unused: has ${what}`);
  }
});

test('a rejected video does not count as progress, so it does not protect an account', async () => {
  const db = world({ campaign_applications: [{ id: 1, clipper_id: 1, campaign_id: 1, attempt: 1, status: 'rejected', created_at: NOW }] });
  assert.equal((await dormantAccounts(db, NOW)).length, 1);
});

test('recently opened, disabled, kept and already deleted accounts are left alone', async () => {
  const at = NOW;
  const db = makeSqliteD1({
    clippers: [
      clipper(1, { last_seen_at: at - 5 * DAY }),          // opened this week
      clipper(2, { status: 'disabled' }),                   // an admin's business
      clipper(3, { dormant_exempt: 1 }),                    // an admin said keep
      clipper(4, { status: 'deleted' }),
      clipper(5)                                            // the only real one
    ]
  });
  const rows = await dormantAccounts(db, at);
  assert.deepEqual(rows.map(r => r.id), [5]);
});

test('an account with no last-seen date falls back to when it was made', async () => {
  const db = makeSqliteD1({ clippers: [clipper(1, { last_seen_at: null, created_at: NOW - 5 * DAY })] });
  assert.equal((await dormantAccounts(db, NOW)).length, 0, 'made five days ago');
});

/* --------------------------------------------------------------- the sweep */

test('the first pass warns on Discord and removes nothing', async () => {
  const sent = fakeDiscord();
  const e = env(world());
  const r = await runDormantSweep(e, NOW);
  assert.deepEqual([r.warned, r.removed], [1, 0]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '111');
  assert.match(sent[0].text, /c1/);
  assert.match(sent[0].text, /deleted/i);

  const row = e.DB._sqlite.prepare('SELECT status, dormant_warned_at, dormant_warned_via FROM clippers WHERE id = 1').get();
  assert.equal(row.status, 'active');
  assert.equal(row.dormant_warned_via, 'discord');
  assert.equal(row.dormant_warned_at, NOW);
});

test('a second pass inside the grace period neither warns again nor removes', async () => {
  const sent = fakeDiscord();
  const e = env(world());
  await runDormantSweep(e, NOW);
  const again = await runDormantSweep(e, NOW + 3 * DAY);
  assert.deepEqual([again.warned, again.removed], [0, 0]);
  assert.equal(sent.length, 1, 'one warning, not one a day');
});

test('after the grace period the account is removed, and everything personal goes with it', async () => {
  fakeDiscord();
  const e = env(world());
  await runDormantSweep(e, NOW);
  const r = await runDormantSweep(e, NOW + GRACE_MS + 1);
  assert.equal(r.removed, 1);

  const row = e.DB._sqlite.prepare('SELECT * FROM clippers WHERE id = 1').get();
  assert.equal(row.status, 'deleted');
  assert.equal(row.deleted_reason, 'inactive');
  assert.match(row.username, /^c1_deleted1$/, 'the username is free again');
  for (const f of ['email', 'contact_number', 'discord_username', 'discord_user_id', 'upi_id', 'legal_name']) {
    assert.equal(row[f], null, `${f} erased`);
  }
  const audit = e.DB._sqlite.prepare("SELECT action, target_label FROM staff_audit_log WHERE action = 'remove_unused_account'").get();
  assert.equal(audit.target_label, 'c1', 'the admin can see what the clean-up did');
});

test('an account nobody could warn is never removed, however long it sits', async () => {
  const sent = fakeDiscord();
  const e = env(makeSqliteD1({ clippers: [clipper(1)] }));    // no Discord linked
  for (const t of [0, 20 * DAY, 200 * DAY]) {
    const r = await runDormantSweep(e, NOW + t);
    assert.equal(r.removed, 0);
    assert.equal(r.unreachable, 1);
  }
  assert.equal(sent.length, 0);
  assert.equal(e.DB._sqlite.prepare('SELECT status FROM clippers WHERE id = 1').get().status, 'active');
  assert.equal((await dormantAccounts(e.DB, NOW))[0].state, 'unreachable', 'the admin still sees it, and why');
});

test('a warning that did not arrive (DMs closed) does not count, so nothing is removed', async () => {
  fakeDiscord({ dmOk: false });
  const e = env(world());
  const first = await runDormantSweep(e, NOW);
  assert.equal(first.warned, 0);
  assert.equal(e.DB._sqlite.prepare('SELECT dormant_warned_at FROM clippers WHERE id = 1').get().dormant_warned_at, null);
  const later = await runDormantSweep(e, NOW + 60 * DAY);
  assert.equal(later.removed, 0, 'never warned, so never removed');
});

test('coming back cancels the warning: a later quiet spell starts the clock again', async () => {
  fakeDiscord();
  const e = env(world());
  await runDormantSweep(e, NOW);
  const c = e.DB._sqlite.prepare('SELECT * FROM clippers WHERE id = 1').get();
  await touchLastSeen(e.DB, c, NOW + 2 * DAY);       // logs in the next day
  const row = e.DB._sqlite.prepare('SELECT last_seen_at, dormant_warned_at, dormant_warned_via FROM clippers WHERE id = 1').get();
  assert.equal(row.last_seen_at, NOW + 2 * DAY);
  assert.equal(row.dormant_warned_at, null);
  assert.equal(row.dormant_warned_via, null);
  // Thirty-odd days after the WARNING but only a few after they were last seen: safe.
  const r = await runDormantSweep(e, NOW + 2 * DAY + GRACE_MS + 1);
  assert.equal(r.removed, 0);
});

test('an old warning from before their last visit is not a warning for the next quiet spell', async () => {
  const db = makeSqliteD1({ clippers: [clipper(1, { discord_user_id: '111', last_seen_at: NOW - 40 * DAY,
    dormant_warned_at: NOW - 60 * DAY, dormant_warned_via: 'discord' })] });
  const [row] = await dormantAccounts(db, NOW);
  assert.equal(row.state, 'unwarned', 'warned before they were last seen, so it does not count');
});

test('one run never removes or warns more than the ceiling', async () => {
  fakeDiscord();
  const ids = [1, 2, 3, 4, 5];
  const e = env(makeSqliteD1({ clippers: ids.map(i => clipper(i, { discord_user_id: `d${i}` })) }));
  const r = await runDormantSweep(e, NOW, { warn: 2, remove: 2 });
  assert.equal(r.warned, 2);
  await runDormantSweep(e, NOW, { warn: 5, remove: 5 });
  const gone = await runDormantSweep(e, NOW + GRACE_MS + 1, { warn: 5, remove: 2 });
  assert.equal(gone.removed, 2, 'five are due, two go today');
});

test('last-seen is written at most once in a while, not on every request', async () => {
  const db = makeSqliteD1({ clippers: [clipper(1, { last_seen_at: NOW - 60 * 1000 })] });
  const c = db._sqlite.prepare('SELECT * FROM clippers WHERE id = 1').get();
  await touchLastSeen(db, c, NOW);
  assert.equal(db._sqlite.prepare('SELECT last_seen_at FROM clippers WHERE id = 1').get().last_seen_at, NOW - 60 * 1000, 'a minute ago is fresh enough');
  await touchLastSeen(db, c, NOW + SEEN_EVERY_MS + 1);
  assert.equal(db._sqlite.prepare('SELECT last_seen_at FROM clippers WHERE id = 1').get().last_seen_at, NOW + SEEN_EVERY_MS + 1);
  assert.equal(DORMANT_AFTER_MS, 30 * DAY);
});

/* ------------------------------------------------- deleting your own account */

async function call(e, path, { method = 'GET', body, id = 1 } = {}) {
  const cookie = await createSessionCookie('clipper', id, SECRET);
  const req = new Request(`https://clipgrow.in${path}`, {
    method, headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  return handleClipper(req, e, new URL(req.url));
}

async function loginWorld(extra = {}) {
  const { hash, salt } = await hashPassword('correct horse');
  return env(makeSqliteD1({
    // The real keys for this profile, so deleting the account visibly frees them.
    clippers: [{ ...clipper(1, { last_seen_at: NOW, discord_user_id: '111', ...identityKeys(COMPLETE_PROFILE) }), password_hash: hash, password_salt: salt }],
    campaigns: [{ id: 1, name: 'C', description: '', cpm: 40, budget: 100000, status: 'active', created_at: NOW,
                  model: 'cpm', min_views: 0, allowed_platforms: 'instagram' }],
    ...extra
  }));
}

test('deleting needs the password: a session left open is not enough', async () => {
  const e = await loginWorld();
  assert.equal((await call(e, '/api/clipper/me/delete', { method: 'POST', body: {} })).status, 400);
  assert.equal((await call(e, '/api/clipper/me/delete', { method: 'POST', body: { password: 'nope' } })).status, 403);
  assert.equal(e.DB._sqlite.prepare('SELECT status FROM clippers WHERE id = 1').get().status, 'active');
});

test('a clipper can delete their own account, and the account is gone at once', async () => {
  const e = await loginWorld();
  const res = await call(e, '/api/clipper/me/delete', { method: 'POST', body: { password: 'correct horse' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Set-Cookie') || '', /cg_session=;|Max-Age=0|expires/i, 'the session is cleared');

  const row = e.DB._sqlite.prepare('SELECT status, username, email, discord_user_id, deleted_reason FROM clippers WHERE id = 1').get();
  assert.equal(row.status, 'deleted');
  assert.equal(row.deleted_reason, 'self');
  assert.equal(row.email, null);
  assert.equal(row.discord_user_id, null);
  assert.notEqual(row.username, 'c1', 'the username is free');

  assert.equal((await call(e, '/api/clipper/me')).status, 401, 'the old session no longer works');
});

test('the username of a deleted account can be taken by someone new', async () => {
  const e = { ...(await loginWorld()), CLIPPER_SIGNUP: 'open' };
  e.DB._sqlite.prepare("UPDATE clippers SET username = 'sam.k'").run();   // long enough to pass the sign-up rules
  await call(e, '/api/clipper/me/delete', { method: 'POST', body: { password: 'correct horse' } });
  const req = new Request('https://clipgrow.in/api/clipper/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    // The same email, number and Discord as the account just deleted: all free again.
    body: JSON.stringify({ username: 'sam.k', password: 'a-long-password-9', email: COMPLETE_PROFILE.email,
      contactNumber: COMPLETE_PROFILE.contact_number, discordUsername: COMPLETE_PROFILE.discord_username }) });
  const res = await handleClipper(req, e, new URL(req.url));
  assert.equal(res.status, 201, 'the name, email, number and Discord are all free');
});

test('money still owed blocks deleting, and says why before a password is typed', async () => {
  const e = await loginWorld({ submissions: [{ id: 1, clipper_id: 1, campaign_id: 1, platform: 'instagram', ig_media_id: 'm', permalink: 'p',
    views: 5000, earning: 200, clipper_earning: 160, status: 'active', eligible: 1, created_at: NOW, posted_at: NOW }] });
  const check = await (await call(e, '/api/clipper/me/delete')).json();
  assert.equal(check.blocked, true);
  assert.match(check.reason, /waiting to be paid/);
  const res = await call(e, '/api/clipper/me/delete', { method: 'POST', body: { password: 'correct horse' } });
  assert.equal(res.status, 409, 'and the server refuses even if the screen was bypassed');
  assert.equal(e.DB._sqlite.prepare('SELECT status FROM clippers WHERE id = 1').get().status, 'active');
});

test('an account with nothing owed is allowed', async () => {
  const check = await (await call(await loginWorld(), '/api/clipper/me/delete')).json();
  assert.equal(check.blocked, false);
});

test('an account with paid history keeps its payout details for the records, and loses the rest', async () => {
  const e = await loginWorld({ payments: [{ id: 1, clipper_id: 1, amount: 500, paid_at: NOW, created_at: NOW }] });
  await call(e, '/api/clipper/me/delete', { method: 'POST', body: { password: 'correct horse' } });
  const row = e.DB._sqlite.prepare('SELECT email, contact_number, upi_id, legal_name FROM clippers WHERE id = 1').get();
  assert.equal(row.email, null);
  assert.equal(row.contact_number, null);
  assert.ok(row.upi_id && row.legal_name, 'a payment record without who was paid cannot be audited');
  assert.equal(e.DB._sqlite.prepare('SELECT COUNT(*) n FROM payments').get().n, 1, 'and the payment itself is untouched');
});

test('a disabled account cannot delete itself from the dashboard', async () => {
  const e = await loginWorld();
  e.DB._sqlite.prepare("UPDATE clippers SET status = 'disabled'").run();
  assert.equal((await call(e, '/api/clipper/me/delete', { method: 'POST', body: { password: 'correct horse' } })).status, 403);
});

test('deleting twice is harmless', async () => {
  const e = await loginWorld();
  assert.equal((await archiveClipper(e, 1, { reason: 'self', scrub: true })).ok, true);
  assert.equal((await archiveClipper(e, 1, { reason: 'self', scrub: true })).already, true);
  assert.equal((await archiveClipper(e, 999, { reason: 'self' })).status, 404);
});

test('selfDeleteBlockers is quiet for a clean account', async () => {
  assert.deepEqual(await selfDeleteBlockers(world(), 1), { blocked: false, reason: null });
});

/* ---------------------------------------------------------------- the admin */

async function admin(e, path, method = 'GET', body) {
  const cookie = await createSessionCookie('admin', 0, SECRET);
  const req = new Request(`https://clipgrow.in${path}`, { method, headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return handleAdmin(req, e, new URL(req.url));
}

test('the admin sees the unused accounts and can keep one', async () => {
  const e = env(world());
  const list = await (await admin(e, '/api/admin/dormant-accounts')).json();
  assert.equal(list.accounts.length, 1);
  assert.equal(list.after_days, 30);
  assert.equal(list.can_warn, true);

  assert.equal((await admin(e, '/api/admin/dormant-accounts/1/keep', 'POST', { keep: true })).status, 200);
  assert.equal((await (await admin(e, '/api/admin/dormant-accounts')).json()).accounts.length, 0, 'kept accounts drop off the list');
  assert.equal((await admin(e, '/api/admin/dormant-accounts/99/keep', 'POST', { keep: true })).status, 404);
});

test('an admin archive still frees the username but does not scrub, so it can be restored', async () => {
  const e = env(world());
  assert.equal((await admin(e, '/api/admin/clippers/1', 'DELETE')).status, 200);
  const row = e.DB._sqlite.prepare('SELECT status, username, email, deleted_reason FROM clippers WHERE id = 1').get();
  assert.equal(row.status, 'deleted');
  assert.equal(row.deleted_reason, 'admin');
  assert.equal(row.username, 'c1_deleted1');
  assert.equal(row.email, COMPLETE_PROFILE.email, 'an archive keeps what a restore needs');
});
