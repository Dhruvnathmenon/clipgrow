// Deleting a parent row while rows still point at it.
//
// D1 enforces foreign keys (PRAGMA foreign_keys = 1 in production), so a DELETE
// that leaves a child behind fails with "FOREIGN KEY constraint failed" and the
// admin sees a bare 500. In production 1,583 of 1,635 clips have a review row and
// 770 have view snapshots, so "Delete clip" failed for almost every real clip --
// while the tests passed, because their clips never had any children.
//
// These tests run against a database where EVERY table has a row, so every parent
// has children, and read the live schema so a table added next month is caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { SUBMISSION_CHILD_TABLES, disconnectSocialAccount } from '../src/db.js';
import { makeHostileWorld, sessionCookies, withNetworkDown } from './helpers/hostile-world.mjs';

const ctx = { waitUntil() {} };

async function admin(env, method, path, body) {
  const cookies = await sessionCookies();
  const res = await worker.fetch(new Request('https://clipgrow.in' + path, {
    method, headers: { Cookie: cookies.admin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
  }), env, ctx);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const count = (env, sql, ...a) => env.DB._sqlite.prepare(sql).get(...a).n;
const fkViolations = env => env.DB._sqlite.prepare('PRAGMA foreign_key_check').all();

test('every table that points at submissions is one the delete code clears', () => {
  const env = makeHostileWorld();
  const children = env.DB._sqlite.prepare(
    `SELECT DISTINCT m.name AS tbl FROM sqlite_master m, pragma_foreign_key_list(m.name) f
      WHERE m.type = 'table' AND f."table" = 'submissions'`
  ).all().map(r => r.tbl).sort();
  assert.deepEqual([...SUBMISSION_CHILD_TABLES].sort(), children,
    'a table now references submissions: add it to SUBMISSION_CHILD_TABLES in src/db.js, or clip deletion breaks in production');
});

test('admin deletes a clip that has a review and view snapshots, and leaves nothing dangling', async () => {
  const env = makeHostileWorld();
  assert.ok(count(env, 'SELECT COUNT(*) n FROM submission_reviews WHERE submission_id = 1') > 0, 'setup: the clip has a review');
  assert.ok(count(env, 'SELECT COUNT(*) n FROM submission_view_snapshots WHERE submission_id = 1') > 0, 'setup: the clip has snapshots');
  const res = await admin(env, 'DELETE', '/api/admin/submissions/1');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(count(env, 'SELECT COUNT(*) n FROM submissions WHERE id = 1'), 0);
  for (const t of SUBMISSION_CHILD_TABLES) assert.equal(count(env, `SELECT COUNT(*) n FROM ${t} WHERE submission_id = 1`), 0, t);
  assert.deepEqual(fkViolations(env), []);
});

test('a paid clip is refused, and keeps its history (children included)', async () => {
  const env = makeHostileWorld();
  env.DB._sqlite.prepare('UPDATE submissions SET locked_at = 1, payment_id = 1 WHERE id = 1').run();
  const res = await admin(env, 'DELETE', '/api/admin/submissions/1');
  assert.equal(res.status, 409);
  assert.equal(count(env, 'SELECT COUNT(*) n FROM submissions WHERE id = 1'), 1);
  assert.ok(count(env, 'SELECT COUNT(*) n FROM submission_reviews WHERE submission_id = 1') > 0, 'the review survives');
  assert.ok(count(env, 'SELECT COUNT(*) n FROM submission_view_snapshots WHERE submission_id = 1') > 0, 'the snapshots survive');
});

test('a clip paid in the gap after it was read keeps its children (the guarded batch deletes nothing)', async () => {
  const env = makeHostileWorld();
  const sql = env.DB._sqlite;
  // The route reads the clip as unpaid, then a payout lands before the delete runs.
  const realPrepare = env.DB.prepare.bind(env.DB);
  let paid = false;
  env.DB.prepare = (q) => {
    const stmt = realPrepare(q);
    if (!paid && /^DELETE FROM submission_reviews/.test(q)) { sql.prepare('UPDATE submissions SET locked_at = 1, payment_id = 1 WHERE id = 1').run(); paid = true; }
    return stmt;
  };
  const res = await admin(env, 'DELETE', '/api/admin/submissions/1');
  assert.equal(res.status, 409);
  assert.equal(count(env, 'SELECT COUNT(*) n FROM submissions WHERE id = 1'), 1);
  assert.ok(count(env, 'SELECT COUNT(*) n FROM submission_reviews WHERE submission_id = 1') > 0, 'the review is still there');
});

test('disconnecting an account whose unpaid clips have snapshots and reviews succeeds', async () => {
  const env = makeHostileWorld();
  const sql = env.DB._sqlite;
  sql.prepare('UPDATE submissions SET account_id = 1 WHERE id = 1').run();
  const out = await disconnectSocialAccount(env.DB, 1);
  assert.ok(out, 'the account was found and disconnected');
  assert.equal(count(env, 'SELECT COUNT(*) n FROM submissions WHERE id = 1'), 0);
  assert.deepEqual(fkViolations(env), []);
});

test('deleting a participation removes its connected-account links first', async () => {
  const env = makeHostileWorld();
  const sql = env.DB._sqlite;
  sql.prepare('DELETE FROM submission_reviews').run();
  sql.prepare('DELETE FROM submission_view_snapshots').run();
  sql.prepare('DELETE FROM submissions').run();
  assert.ok(count(env, 'SELECT COUNT(*) n FROM participation_accounts WHERE participation_id = 1') > 0, 'setup');
  const res = await admin(env, 'DELETE', '/api/admin/participations/1');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(count(env, 'SELECT COUNT(*) n FROM participation_accounts WHERE participation_id = 1'), 0);
  assert.deepEqual(fkViolations(env), []);
});

test('pointing a participation at an account that does not exist is a 400, not a database error', async () => {
  const env = makeHostileWorld();
  for (const account_id of [999999, 0, -1, 'abc', [1], { a: 1 }, true, 1.5]) {
    const res = await admin(env, 'PATCH', '/api/admin/participations/1', { account_id });
    assert.equal(res.status, 400, `account_id=${JSON.stringify(account_id)}`);
  }
  assert.equal((await admin(env, 'PATCH', '/api/admin/participations/1', { account_id: 1 })).status, 200, 'a real account still works');
  assert.equal((await admin(env, 'PATCH', '/api/admin/participations/1', { account_id: null })).status, 200, 'and so does clearing it');
});

test('deleting a campaign: clear reasons to refuse, and a full clean-up when nothing must be kept', async () => {
  const env = makeHostileWorld();
  const sql = env.DB._sqlite;

  let res = await admin(env, 'DELETE', '/api/admin/campaigns/1');
  assert.equal(res.status, 409, 'it has submissions');
  assert.match(res.body.error, /submission/i);

  sql.prepare('DELETE FROM submission_reviews').run();
  sql.prepare('DELETE FROM submission_view_snapshots').run();
  sql.prepare('DELETE FROM submissions').run();
  sql.prepare('UPDATE payments SET campaign_id = 1').run();
  res = await admin(env, 'DELETE', '/api/admin/campaigns/1');
  assert.equal(res.status, 409, 'it has payments');
  assert.match(res.body.error, /payment/i);

  sql.prepare('DELETE FROM payments').run();
  res = await admin(env, 'DELETE', '/api/admin/campaigns/1');
  assert.equal(res.status, 409, 'it has reviewed video applications');
  assert.match(res.body.error, /application/i);
  assert.equal(count(env, 'SELECT COUNT(*) n FROM campaigns WHERE id = 1'), 1, 'and nothing was deleted by the refusals');

  sql.prepare('DELETE FROM campaign_applications').run();
  res = await admin(env, 'DELETE', '/api/admin/campaigns/1');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  for (const [t, col] of [['campaigns', 'id'], ['participations', 'campaign_id'], ['tester_requests', 'campaign_id'], ['client_campaigns', 'campaign_id']]) {
    assert.equal(count(env, `SELECT COUNT(*) n FROM ${t} WHERE ${col} = 1`), 0, t);
  }
  assert.equal(count(env, 'SELECT COUNT(*) n FROM participation_accounts WHERE participation_id = 1'), 0);
  assert.deepEqual(fkViolations(env), []);
});

test('a request that sends an object where a value belongs is a 400 (the database refuses the type), not a 500', async () => {
  const net = withNetworkDown();
  try {
    const env = makeHostileWorld();
    const res = await admin(env, 'PATCH', '/api/admin/participations/1', { note: { not: 'text' } });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /wrong type/i);
  } finally { net.restore(); }
});
