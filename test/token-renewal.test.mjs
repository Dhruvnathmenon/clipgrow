// Instagram tokens last 60 days but can be extended another 60 while still
// valid. Nothing was doing that, so every token expired on day 60 and its
// clipper hit "reconnect needed". renewInstagramTokens (on the cron) keeps
// them topped up; a token that truly can't be saved is marked needs_reauth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { renewInstagramTokens, RENEW_WITHIN_MS } from '../src/token-renewal.js';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function seed(accounts) {
  return makeSqliteD1({
    clippers: [{ id: 1, username: 'c1', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }],
    social_accounts: accounts
  });
}
const igAcct = (id, o = {}) => ({
  id, clipper_id: 1, platform: 'instagram', username: 'ig' + id, external_id: 'e' + id,
  status: 'connected', access_token: 'tok' + id, auto_import: 1, connected_at: NOW - 50 * DAY,
  token_expires_at: NOW + 5 * DAY, ...o
});

function fetchStub(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => handler(String(url));
  return () => { globalThis.fetch = real; };
}
const okJson = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const errJson = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('a token near expiry is extended by 60 days and its error state cleared', async () => {
  const db = seed([igAcct(1, { token_expires_at: NOW + 3 * DAY, last_error_code: 'X' })]);
  const restore = fetchStub(() => okJson({ access_token: 'FRESH', token_type: 'bearer', expires_in: 5184000 }));
  try {
    const r = await renewInstagramTokens(db, {}, { now: NOW });
    assert.deepEqual(r.renewed, [1]);
    const a = db._rows('social_accounts')[0];
    assert.equal(a.access_token, 'FRESH');
    assert.ok(a.token_expires_at > NOW + 55 * DAY, 'pushed out ~60 days');
    assert.equal(a.last_error_code, null);
    assert.equal(a.status, 'connected');
  } finally { restore(); }
});

test('a token with plenty of life left is left alone', async () => {
  const db = seed([igAcct(1, { token_expires_at: NOW + 40 * DAY })]);
  let called = false;
  const restore = fetchStub(() => { called = true; return okJson({ access_token: 'x', expires_in: 1 }); });
  try {
    const r = await renewInstagramTokens(db, {}, { now: NOW });
    assert.equal(called, false, 'no refresh call made');
    assert.deepEqual(r.renewed, []);
  } finally { restore(); }
});

test('a revoked token is marked needs_reauth -- the one case a clipper must act on', async () => {
  const db = seed([igAcct(1, { token_expires_at: NOW + 2 * DAY })]);
  // Meta code 190 subcode 458 == user removed the app.
  const restore = fetchStub(() => errJson(400, { error: { code: 190, error_subcode: 458, message: 'revoked' } }));
  try {
    const r = await renewInstagramTokens(db, {}, { now: NOW });
    assert.deepEqual(r.reauth, [1]);
    assert.deepEqual(r.renewed, []);
    assert.equal(db._rows('social_accounts')[0].status, 'needs_reauth');
  } finally { restore(); }
});

test('a transient failure leaves the token connected for the next cron pass', async () => {
  const db = seed([igAcct(1, { token_expires_at: NOW + 2 * DAY })]);
  const restore = fetchStub(() => errJson(500, { error: { message: 'server error' } }));
  try {
    const r = await renewInstagramTokens(db, {}, { now: NOW });
    assert.deepEqual(r.failed, [1]);
    assert.equal(db._rows('social_accounts')[0].status, 'connected', 'not knocked offline over a blip');
  } finally { restore(); }
});

test('only Instagram, only connected, and capped per pass', async () => {
  const db = seed([
    igAcct(1, { token_expires_at: NOW + 1 * DAY }),
    igAcct(2, { token_expires_at: NOW + 1 * DAY }),
    igAcct(3, { token_expires_at: NOW + 1 * DAY }),
    igAcct(4, { platform: 'youtube', token_expires_at: NOW - DAY }),
    igAcct(5, { status: 'revoked', token_expires_at: NOW + 1 * DAY })
  ]);
  const restore = fetchStub(() => okJson({ access_token: 'FRESH', expires_in: 5184000 }));
  try {
    const r = await renewInstagramTokens(db, {}, { now: NOW, max: 2 });
    assert.equal(r.renewed.length, 2, 'stopped at the cap');
    assert.ok(!r.renewed.includes(4), 'YouTube untouched');
    assert.ok(!r.renewed.includes(5), 'revoked account untouched');
  } finally { restore(); }
});
