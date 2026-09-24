// Nothing a visitor can send may make the Worker throw.
//
// A 500 means an exception nobody handled. Every one of these sweeps found real
// ones the first time they ran: a body of `null` (every route that read a field
// crashed), a stray "%" in ANY cookie on the domain (every request that visitor
// made crashed), garbage in ?state= on the OAuth callbacks, ?offset=1e21, an
// array where an id belongs. They are all fixed; this keeps them fixed, and it
// finds the same mistake in a route that has not been written yet, because the
// routes are read out of the source.
//
// What is asserted is deliberately weak -- "no 5xx" -- because the right answer
// to nonsense varies (400, 401, 404 are all fine). What is never fine is a crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {
  routePaths, bodyFieldNames, queryNames, makeHostileWorld, sessionCookies, withNetworkDown, Failures
} from './helpers/hostile-world.mjs';

const PATHS = routePaths();
const ROLES = ['anon', 'admin', 'clipper', 'moderator', 'client'];
const ctx = { waitUntil() {} };
// 503 is a deliberate answer ("that feature is not switched on"), not a crash.
const crashed = s => s >= 500 && s !== 503;

let serial = 0;
async function send(env, cookies, role, method, path, { body, cookie, headers = {} } = {}, fails, label) {
  serial++;
  const h = { 'CF-Connecting-IP': `198.51.100.${serial % 250}`, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const c = cookie !== undefined ? cookie : (role !== 'anon' ? cookies[role] : undefined);
  if (c) h.Cookie = c;
  if (path.startsWith('/api/bot/')) h.Authorization = 'Bearer bot-token-for-tests';
  const net = withNetworkDown.current;
  net.captured.length = 0;
  let status;
  try {
    status = (await worker.fetch(new Request('https://clipgrow.in' + path, { method, headers: h, body: method === 'GET' ? undefined : body }), env, ctx)).status;
  } catch (e) { status = `THREW ${String(e && e.message).slice(0, 80)}`; }
  if (typeof status !== 'number' || crashed(status)) {
    const why = net.captured.find(l => l.startsWith('handler error')) || '';
    fails.add(`${status} ${why.split('\n').slice(0, 2).join(' | ').slice(0, 220)}`, `${label || role} ${method} ${path} ${body === undefined ? '' : 'body=' + String(body).slice(0, 80)}`);
  }
}

test('the sweep actually found the routes (a broken extractor would test nothing)', () => {
  assert.ok(PATHS.length > 100, `only ${PATHS.length} routes found`);
  for (const must of ['/api/admin/login', '/api/clipper/me', '/api/clipper/signup', '/api/bot/answer', '/api/moderator/login']) {
    assert.ok(PATHS.includes(must), `${must} not found by the route extractor`);
  }
  assert.ok(bodyFieldNames().length > 40);
});

function bodies() {
  const fields = bodyFieldNames();
  const uniform = v => JSON.stringify(Object.fromEntries(fields.map(f => [f, v])));
  return [
    undefined, '', 'null', '[]', '"str"', '123', 'true', '{', '{}', 'not json',
    '{"a":' + '['.repeat(2000),
    uniform(null), uniform(0), uniform(-1), uniform(1e308), uniform(''), uniform('A'.repeat(5000)),
    uniform([]), uniform([1, 2]), uniform({}), uniform({ a: 1 }), uniform(true), uniform("'; DROP TABLE clippers;--"), uniform('\u0000')
  ];
}

for (const role of ROLES) {
  test(`${role}: hostile bodies and ids never crash any route`, async () => {
    const net = withNetworkDown(); withNetworkDown.current = net;
    try {
      const cookies = await sessionCookies();
      const fails = new Failures();
      const bs = bodies();
      for (const tpl of PATHS) {
        // a fresh world per route: a hostile request may legitimately delete rows
        const env = makeHostileWorld();
        const ids = tpl.includes('{id}') ? ['1', 'abc', '99999999999999999999'] : [''];
        for (const id of ids) {
          const path = tpl.replace(/\{id\}/g, id);
          await send(env, cookies, role, 'GET', path, {}, fails);
          for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
            for (const body of (method === 'DELETE' || id === '99999999999999999999') ? [undefined, '{}'] : bs) {
              await send(env, cookies, role, method, path, { body }, fails);
            }
          }
        }
      }
      assert.equal(fails.size, 0, `\n${fails.describe()}`);
    } finally { net.restore(); }
  });
}

test('hostile query strings never crash any route (paging, ids, dates, huge numbers)', async () => {
  const net = withNetworkDown(); withNetworkDown.current = net;
  try {
    const cookies = await sessionCookies();
    const fails = new Failures();
    const values = ['', 'abc', '-1', '0', '1', '2.5', '-0.5', '1e21', '1e308', '999999999999999999999', '9007199254740993', 'NaN', 'null', '[]', '%00', "' OR 1=1--", '../..', 'x'.repeat(3000), '2026-13-45'];
    const names = queryNames();
    const everyName = v => names.map(n => `${n}=${encodeURIComponent(v)}`).join('&');
    // GET requests only read, so one database per role is enough (building the
    // schema is what costs time, not the requests)
    const worlds = Object.fromEntries(ROLES.map(r => [r, makeHostileWorld()]));
    for (const tpl of PATHS) {
      for (const role of ROLES) {
        const env = worlds[role];
        const path = tpl.replace(/\{id\}/g, '1');
        // every parameter the code reads, all set to the same hostile value...
        for (const v of values) await send(env, cookies, role, 'GET', `${path}?${everyName(v)}`, {}, fails);
        // ...and, for the signed-in roles, each parameter on its own with the
        // values that have broken paging and id parsing before
        if (role === 'anon') continue;
        for (const name of names) for (const v of ['abc', '1e21', '2.5']) {
          await send(env, cookies, role, 'GET', `${path}?${name}=${encodeURIComponent(v)}`, {}, fails);
        }
      }
    }
    assert.equal(fails.size, 0, `\n${fails.describe()}`);
  } finally { net.restore(); }
});

test('hostile cookies and headers never crash any route or page', async () => {
  const net = withNetworkDown(); withNetworkDown.current = net;
  try {
    const fails = new Failures();
    const env = makeHostileWorld();
    const pages = ['/', '/for-clippers', '/admin', '/dashboard', '/tracker', '/login', '/sitemap.xml', '/robots.txt', '/guides/x', '/media/x', '/nope', '/new/x', '/api', '//', '/%', '/%E0%A4%A', '/' + 'a'.repeat(5000)];
    const cookies = [
      'cg_session=%', 'cg_session=%E0%A4%A', 'cg_session=a.b', 'cg_session=.', 'cg_session=' + 'A'.repeat(4000), 'cg_session=.....',
      'x=%; cg_session=y', 'cg_session', '=;;;===', 'cg_session=eyJ.eyJ', 'a=%FF', 'cg_session=%00.%00'
    ];
    const headers = [
      {}, { Authorization: 'Bearer' }, { Authorization: 'Bearer ' }, { Authorization: 'Basic %%%' }, { Authorization: 'Bearer ' + 'x'.repeat(10000) },
      { 'Content-Type': 'application/x-www-form-urlencoded' }, { 'Content-Type': 'multipart/form-data' }, { 'Content-Type': 'text/plain; charset=bogus' },
      { 'CF-Connecting-IP': 'not an ip' }, { 'X-Forwarded-For': ',,,' }, { Origin: 'null' }, { Referer: '%' }
    ];
    for (const p of [...PATHS.map(t => t.replace(/\{id\}/g, '1')), ...pages]) {
      for (const method of ['GET', 'POST']) for (const cookie of cookies) for (const h of headers) {
        await send(env, {}, 'anon', method, p, { body: method === 'POST' ? '{}' : undefined, cookie, headers: h }, fails, 'cookie=' + cookie.slice(0, 24));
      }
    }
    assert.equal(fails.size, 0, `\n${fails.describe()}`);
  } finally { net.restore(); }
});
