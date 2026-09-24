// Shared set-up for the hostile-input sweeps (test/hostile-input.test.mjs).
//
// The routes are read out of the source rather than listed by hand, so a route
// added next month is attacked the day it is written without anyone remembering
// to add it here. The database is the real schema with one row in EVERY table:
// required columns hold plausible dummies and every nullable column is left NULL,
// which is what old or half-filled production rows look like.
import { readFileSync, readdirSync } from 'node:fs';
import { makeSqliteD1 } from './sqlite-d1.mjs';
import { createSessionCookie } from '../../src/auth.js';

export const SECRET = 'hostile-test-secret';
const ROOT = new URL('../../', import.meta.url);
const read = p => readFileSync(new URL(p, ROOT), 'utf8');

const routeFiles = [...readdirSync(new URL('src/routes/', ROOT)).map(f => 'src/routes/' + f), 'src/bot-api.js'];

/** Every /api/... path the code mentions, with {id} where a parameter goes. */
export function routePaths() {
  const found = new Set();
  for (const f of routeFiles) {
    const s = read(f);
    for (const m of s.matchAll(/['"`](\/api\/[A-Za-z0-9_\-\/:.]*)['"`]/g)) found.add(m[1]);
    for (const m of s.matchAll(/pathname\.startsWith\('([^']+)'\)/g)) found.add(m[1].replace(/\/$/, '') + '/{id}');
    // matchPath('/api/x/:id/y', pathname)
    for (const m of s.matchAll(/matchPath\(\s*['"`](\/api\/[^'"`]+)['"`]/g)) found.add(m[1].replace(/:[A-Za-z_]+/g, '{id}'));
  }
  const out = new Set();
  for (let t of found) {
    if (!t.startsWith('/api/')) continue;
    t = t.replace(/:[A-Za-z_]+/g, '{id}').replace(/\/$/, '');
    if (/[\\^$()|*]/.test(t.replace(/\{id\}/g, ''))) continue;
    out.add(t);
  }
  return [...out].sort();
}

/** Names a route might read from a JSON body, gathered from the source. */
export function bodyFieldNames() {
  const names = new Set();
  for (const f of routeFiles) {
    const s = read(f);
    for (const m of s.matchAll(/\b(?:payload|body|b|data|input|form|sent)\.([a-z_][a-z0-9_]*)/gi)) names.add(m[1]);
    for (const m of s.matchAll(/(?:const|let)\s*\{([^}=]*)\}\s*=\s*(?:await\s+)?readJson/g)) {
      for (const n of m[1].split(',')) { const k = n.split(':')[0].trim(); if (/^[a-z_][a-z0-9_]*$/i.test(k)) names.add(k); }
    }
  }
  return [...names].filter(n => n.length > 1 && n.length < 40);
}

/** Every query-string name the code reads. */
export function queryNames() {
  const names = new Set(['limit', 'offset', 'id', 'before_id']);
  for (const f of routeFiles) for (const m of read(f).matchAll(/searchParams\.get\('([a-z_]+)'\)/g)) names.add(m[1]);
  for (const m of read('src/routes/admin.js').matchAll(/numOrNull\('([a-z_]+)'\)/g)) names.add(m[1]);
  return [...names];
}

export function makeHostileWorld() {
  const db = makeSqliteD1({});
  const sql = db._sqlite;
  const now = Date.now();
  for (const { name: t } of sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    const names = [], vals = [];
    for (const c of sql.prepare(`SELECT * FROM pragma_table_info('${t}')`).all()) {
      if ((c.dflt_value != null && !c.pk) || (!c.notnull && !c.pk)) continue;
      names.push(c.name);
      const type = (c.type || '').toUpperCase();
      if (c.pk) vals.push(1);
      else if (/INT|REAL|NUM/.test(type)) vals.push(/created|updated|_at|ts|time/i.test(c.name) ? now : 1);
      else vals.push(/status/.test(c.name) ? 'active' : /username|handle/.test(c.name) ? 'user1' : 'x');
    }
    try { sql.prepare(`INSERT INTO ${t} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...vals); }
    catch { /* a table that needs a bespoke row stays empty: the empty case is worth testing too */ }
  }
  return {
    DB: db,
    SESSION_SECRET: SECRET,
    ADMIN_PASSWORD: 'admin-pass-for-tests',
    ASSETS: { fetch: async () => new Response('asset', { headers: { 'content-type': 'text/html' } }) },
    REFRESH_QUEUE: { send: async () => {} },
    // Everything switched ON, so the most code is reachable.
    CLIPPER_SIGNUP: 'open', DISCORD_LINK: 'required', BOT_API_TOKEN: 'bot-token-for-tests',
    DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 's', DISCORD_BOT_TOKEN: 't', DISCORD_GUILD_ID: '1'
  };
}

export async function sessionCookies() {
  const out = {};
  for (const [role, sub] of [['admin', 'admin'], ['clipper', '1'], ['moderator', '1'], ['client', '1']]) {
    out[role] = (await createSessionCookie(role, sub, SECRET)).split(';')[0];
  }
  return out;
}

/** Runs the Worker with the network down and console noise captured. */
export function withNetworkDown() {
  const real = { fetch: globalThis.fetch, error: console.error, warn: console.warn };
  const captured = [];
  globalThis.fetch = async (u) => { throw new TypeError('network down (test): ' + String(u).slice(0, 60)); };
  console.error = (...a) => { captured.push(a.map(String).join(' ')); };
  console.warn = () => {};
  return { captured, restore() { globalThis.fetch = real.fetch; console.error = real.error; console.warn = real.warn; } };
}

/** Collapses failures to distinct causes so a report is readable. */
export class Failures {
  constructor() { this.map = new Map(); }
  add(key, example) {
    const e = this.map.get(key) || { count: 0, example };
    e.count++; this.map.set(key, e);
  }
  get size() { return this.map.size; }
  describe() { return [...this.map].map(([k, v]) => `[${v.count}x] ${k}\n    e.g. ${v.example}`).join('\n'); }
}
