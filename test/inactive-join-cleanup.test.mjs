// A clipper who joins a campaign but never connects any account to it used
// to sit on the roster forever -- inflating "joined" headcount with someone
// who will never post a clip, indistinguishable from someone actually
// working. removeInactiveJoins clears these out a week after they joined,
// but only when they truly never connected anything: a connection that
// broke AFTER being made (needs_reauth, revoked) must not be swept up here,
// since participation_accounts is never touched by a token going bad --
// only a genuine disconnect removes that row. This is a straight DELETE
// (not a status change) so pressing Join Campaign again just works, unlike
// a kick.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { removeInactiveJoins, JOIN_GRACE_PERIOD_MS } from '../src/refresh-jobs.js';

const NOW = Date.now();
const OVER_A_WEEK_AGO = NOW - JOIN_GRACE_PERIOD_MS - 60_000;
const WITHIN_THE_WEEK = NOW - 60_000;

function seed({ participations = [], accounts = [], links = [] }) {
  return makeSqliteD1({
    clippers: [
      { id: 1, username: 'never_connected', password_hash: 'h', password_salt: 's', created_at: OVER_A_WEEK_AGO },
      { id: 2, username: 'connected_fine', password_hash: 'h', password_salt: 's', created_at: OVER_A_WEEK_AGO },
      { id: 3, username: 'connection_broke', password_hash: 'h', password_salt: 's', created_at: OVER_A_WEEK_AGO },
      { id: 4, username: 'new_joiner', password_hash: 'h', password_salt: 's', created_at: NOW }
    ],
    campaigns: [{ id: 1, name: 'T', cpm: 40, budget: 100000, status: 'active',
                  created_at: OVER_A_WEEK_AGO, min_views: 1000, allowed_platforms: 'instagram' }],
    social_accounts: accounts,
    participations,
    participation_accounts: links
  });
}

test('removes a participation that has gone a week with zero accounts ever linked', async () => {
  const db = seed({
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: OVER_A_WEEK_AGO }]
  });
  const removed = await removeInactiveJoins(db, { now: NOW });
  assert.deepEqual(removed, [1]);
  assert.equal(await db.prepare('SELECT * FROM participations WHERE id = 1').first(), null);
});

test('keeps a participation with a currently-linked account, however old', async () => {
  const db = seed({
    participations: [{ id: 1, clipper_id: 2, campaign_id: 1, status: 'active', joined_at: OVER_A_WEEK_AGO }],
    accounts: [{ id: 10, clipper_id: 2, platform: 'instagram', external_id: 'ig10', username: 'h',
                 access_token: 't', status: 'connected', connected_at: OVER_A_WEEK_AGO }],
    links: [{ id: 1, participation_id: 1, account_id: 10, platform: 'instagram', linked_at: OVER_A_WEEK_AGO }]
  });
  const removed = await removeInactiveJoins(db, { now: NOW });
  assert.deepEqual(removed, []);
  assert.ok(await db.prepare('SELECT * FROM participations WHERE id = 1').first());
});

test('keeps a participation whose linked account later broke (needs_reauth/revoked) -- the link row survives that', async () => {
  // This is the case that matters most: a connection going bad after being
  // made is a completely different situation from never connecting at all,
  // and must never be punished the same way.
  const db = seed({
    participations: [{ id: 1, clipper_id: 3, campaign_id: 1, status: 'active', joined_at: OVER_A_WEEK_AGO }],
    accounts: [{ id: 10, clipper_id: 3, platform: 'instagram', external_id: 'ig10', username: 'h',
                 access_token: 't', status: 'revoked', last_error_code: 'TOKEN_REVOKED', connected_at: OVER_A_WEEK_AGO }],
    links: [{ id: 1, participation_id: 1, account_id: 10, platform: 'instagram', linked_at: OVER_A_WEEK_AGO }]
  });
  const removed = await removeInactiveJoins(db, { now: NOW });
  assert.deepEqual(removed, []);
  assert.ok(await db.prepare('SELECT * FROM participations WHERE id = 1').first());
});

test('leaves a recent joiner alone -- still inside the grace period', async () => {
  const db = seed({
    participations: [{ id: 1, clipper_id: 4, campaign_id: 1, status: 'active', joined_at: WITHIN_THE_WEEK }]
  });
  const removed = await removeInactiveJoins(db, { now: NOW });
  assert.deepEqual(removed, []);
});

test('never touches a paused or kicked participation, even if unconnected and old', async () => {
  const db = seed({
    participations: [
      { id: 1, clipper_id: 1, campaign_id: 1, status: 'paused', joined_at: OVER_A_WEEK_AGO },
      { id: 2, clipper_id: 2, campaign_id: 1, status: 'kicked', joined_at: OVER_A_WEEK_AGO }
    ]
  });
  const removed = await removeInactiveJoins(db, { now: NOW });
  assert.deepEqual(removed, []);
});

test('logs an audit entry naming the clipper and campaign for each removal', async () => {
  const db = seed({
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: OVER_A_WEEK_AGO }]
  });
  await removeInactiveJoins(db, { now: NOW });
  const row = await db.prepare("SELECT * FROM staff_audit_log WHERE action = 'participation_auto_removed'").first();
  assert.ok(row, 'an audit entry was written');
  assert.equal(row.staff_type, 'system');
  assert.equal(row.target_label, 'never_connected');
  assert.match(row.detail, /joined over a week ago, never connected/);
});

test('a mixed batch removes only the ones that actually qualify', async () => {
  const db = seed({
    participations: [
      { id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: OVER_A_WEEK_AGO }, // qualifies
      { id: 2, clipper_id: 2, campaign_id: 1, status: 'active', joined_at: OVER_A_WEEK_AGO }, // has a link
      { id: 3, clipper_id: 4, campaign_id: 1, status: 'active', joined_at: WITHIN_THE_WEEK }  // too new
    ],
    accounts: [{ id: 10, clipper_id: 2, platform: 'instagram', external_id: 'ig10', username: 'h',
                 access_token: 't', status: 'connected', connected_at: OVER_A_WEEK_AGO }],
    links: [{ id: 1, participation_id: 2, account_id: 10, platform: 'instagram', linked_at: OVER_A_WEEK_AGO }]
  });
  const removed = await removeInactiveJoins(db, { now: NOW });
  assert.deepEqual(removed, [1]);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM participations').first()).n, 2);
});
