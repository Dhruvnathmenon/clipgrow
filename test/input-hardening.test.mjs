// The small, sharp fixes behind the hostile-input sweeps, each pinned on its own
// so a regression names the exact function instead of "some route returned 500".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJson } from '../src/http.js';
import { verifyPassword, hashPassword, verifySession, signSession, parseCookies } from '../src/auth.js';
import { clampInt, parseStored } from '../src/sql-utils.js';
import { reviewLog } from '../src/applications.js';
import { listAuditLog } from '../src/audit.js';
import { listErrors } from '../src/error-log.js';
import { reviewedList } from '../src/reviews.js';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { makeHostileWorld, sessionCookies } from './helpers/hostile-world.mjs';
import worker from '../src/worker.js';

const asRequest = body => new Request('https://x.test/', { method: 'POST', body });

test('readJson: always an object, whatever valid or invalid JSON arrives', async () => {
  assert.deepEqual(await readJson(asRequest('{"a":1}')), { a: 1 });
  for (const bad of ['null', '[]', '[1,2]', '"str"', '123', 'true', '', '{', 'not json', '{"a":' + '['.repeat(5000)]) {
    const got = await readJson(asRequest(bad));
    assert.deepEqual(got, {}, `body ${JSON.stringify(bad.slice(0, 20))}`);
  }
  // so the first field read on it can never throw
  assert.equal((await readJson(asRequest('null'))).name, undefined);
});

test('verifyPassword: a malformed stored hash or salt is "wrong password", never an exception', async () => {
  const { hash, salt } = await hashPassword('correct-horse-9');
  assert.equal(await verifyPassword('correct-horse-9', hash, salt), true);
  assert.equal(await verifyPassword('wrong', hash, salt), false);
  for (const [h, s] of [[hash, 'x'], [hash, ''], [hash, null], [hash, undefined], [hash, 'abc'], [hash, 'zz'], [null, salt], [undefined, salt], [123, salt], [hash, 42]]) {
    assert.equal(await verifyPassword('correct-horse-9', h, s), false, `hash=${String(h).slice(0, 8)} salt=${String(s)}`);
  }
});

test('verifySession: garbage of every shape is "not signed in"', async () => {
  const good = await signSession({ role: 'clipper', sub: '1', exp: Date.now() + 60000 }, 'sec');
  assert.equal((await verifySession(good, 'sec')).sub, '1');
  assert.equal(await verifySession(good, 'other-secret'), null, 'wrong key');
  const expired = await signSession({ role: 'clipper', sub: '1', exp: Date.now() - 1 }, 'sec');
  assert.equal(await verifySession(expired, 'sec'), null, 'expired');
  for (const bad of [undefined, null, '', '.', '..', 'a.b', '%.%', 'a.b.c', '2.5', '\u0000.\u0000', 'A'.repeat(5000), 'eyJ.eyJ', '!!!.???', good.slice(0, -3), good + 'x', 42, {}, []]) {
    assert.equal(await verifySession(bad, 'sec'), null, `token ${JSON.stringify(String(bad).slice(0, 20))}`);
  }
});

test('parseCookies: one malformed cookie cannot break reading the others', () => {
  const read = header => parseCookies(new Request('https://x.test/', { headers: { Cookie: header } }));
  assert.deepEqual(read('a=1; b=two'), { a: '1', b: 'two' });
  assert.equal(read('a=%20x').a, ' x', 'valid escapes still decode');
  // the malformed one keeps its raw text, and its neighbours are untouched
  const got = read('junk=%; cg_session=abc; other=%E0%A4%A');
  assert.equal(got.junk, '%');
  assert.equal(got.cg_session, 'abc');
  assert.equal(got.other, '%E0%A4%A');
  for (const h of ['', '=', ';;;', '=;;;===', 'noequals', 'a=', '%=%', 'x'.repeat(9000)]) assert.doesNotThrow(() => read(h), h.slice(0, 12));
});

test('clampInt: whole numbers in range from anything', () => {
  assert.equal(clampInt('25', 50, 1, 200), 25);
  assert.equal(clampInt(undefined, 50, 1, 200), 50);
  assert.equal(clampInt('abc', 50, 1, 200), 50);
  assert.equal(clampInt('', 50, 1, 200), 50);
  assert.equal(clampInt(0, 50, 1, 200), 50, '0 reads as "not given", as before');
  assert.equal(clampInt(2.9, 50, 1, 200), 2, 'fractions are cut, never passed to SQL');
  assert.equal(clampInt(-5, 50, 1, 200), 1);
  assert.equal(clampInt(1e21, 50, 1, 200), 200);
  assert.equal(clampInt(Infinity, 50, 1, 200), 200);
  assert.equal(clampInt(-Infinity, 50, 1, 200), 1);
  assert.equal(clampInt('1e21', 0, 0, 1000000), 1000000);
  assert.equal(clampInt([], 7, 1, 9), 7);
  assert.equal(clampInt({}, 7, 1, 9), 7);
  assert.equal(clampInt(null, 7, 1, 9), 7);
  for (const v of [1e21, -1e21, 2.5, NaN, 'x', '9007199254740993']) assert.ok(Number.isInteger(clampInt(v, 5, 0, 1000)), String(v));
});

test('every paged list survives limit/offset values that used to reach SQL as non-integers', async () => {
  const db = makeSqliteD1({});
  for (const v of [2.5, 1e21, -1, 0, 'abc', NaN, Infinity, '9999999999999999999999', {}, []]) {
    await reviewLog(db, { limit: v, offset: v });
    await listAuditLog(db, { limit: v, beforeId: null });
    await listErrors(db, { limit: v });
    await reviewedList(db, { limit: v });
  }
});

test('parseStored: a corrupt cell reads as empty in the shape asked for', () => {
  assert.deepEqual(parseStored('[1,2]', []), [1, 2]);
  assert.deepEqual(parseStored('{"a":1}', {}), { a: 1 });
  for (const bad of [null, undefined, '', '{', 'not json', 'null', '"str"', '5']) {
    assert.deepEqual(parseStored(bad, []), [], `array from ${JSON.stringify(bad)}`);
    assert.deepEqual(parseStored(bad, {}), {}, `object from ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(parseStored('{"a":1}', []), [], 'an object where a list is required is empty');
  assert.deepEqual(parseStored('[1]', {}), {}, 'a list where an object is required is empty');
});

test('the OAuth callbacks treat a garbage ?state= as an expired link, not a crash', async () => {
  const env = makeHostileWorld();
  for (const provider of ['discord', 'instagram', 'youtube']) {
    for (const state of ['2.5', 'a.b', '%', '.', '\u0000', 'x'.repeat(4000)]) {
      const res = await worker.fetch(new Request(`https://clipgrow.in/api/auth/${provider}/callback?state=${encodeURIComponent(state)}&code=c`), env, { waitUntil() {} });
      assert.ok(res.status < 500, `${provider} state=${state.slice(0, 10)} -> ${res.status}`);
    }
  }
});

test('a broken cookie is "logged out" on a page, never an error', async () => {
  const env = makeHostileWorld();
  for (const cookie of ['cg_session=%', 'cg_session=a.b', 'x=%; cg_session=y', 'cg_session=%E0%A4%A']) {
    for (const path of ['/api/clipper/me', '/api/admin/overview', '/api/client/me', '/api/moderator/me']) {
      const res = await worker.fetch(new Request('https://clipgrow.in' + path, { headers: { Cookie: cookie } }), env, { waitUntil() {} });
      assert.equal(res.status, 401, `${path} with ${cookie}`);
    }
  }
});

test('submitting a video with a campaign_id that is not a number is refused with a 400', async () => {
  const env = makeHostileWorld();
  const cookies = await sessionCookies();
  for (const campaign_id of [[1], [1, 2], { a: 1 }, true, null, '', 'abc', 1.5, -1, 0, 1e21]) {
    const res = await worker.fetch(new Request('https://clipgrow.in/api/clipper/submissions', {
      method: 'POST', headers: { Cookie: cookies.clipper, 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign_id, url: 'https://www.instagram.com/reel/abc/' })
    }), env, { waitUntil() {} });
    assert.ok(res.status >= 400 && res.status < 500, `campaign_id=${JSON.stringify(campaign_id)} -> ${res.status}`);
  }
});
