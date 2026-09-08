// A clipper who joins a campaign but never connects any account to it used
// to sit on the roster forever -- inflating "joined" headcount with someone
// who will never post a clip, indistinguishable from someone actually
// working. removeInactiveJoins flags these a week after they joined, but
// only when they truly never connected anything: a connection that broke
// AFTER being made (needs_reauth, revoked) must not be swept up here, since
// participation_accounts is never touched by a token going bad -- only a
// genuine disconnect removes that row.
//
// This is a soft flag (inactive_at), not a delete and not a status change --
// the clipper hasn't done anything wrong, so nothing about their actual
// participation moves. linkParticipationAccount clears the flag the instant
// they connect anything at all, automatically, so this is meant to be
// invisible to them start to finish.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { removeInactiveJoins, JOIN_GRACE_PERIOD_MS } from '../src/refresh-jobs.js';
import { linkParticipationAccount } from '../src/db.js';

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

test('flags (does not delete) a participation that has gone a week with zero accounts ever linked', async () => {
  const db = seed({
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: OVER_A_WEEK_AGO }]
  });
  const flagged = await removeInactiveJoins(db, { now: NOW });
  assert.deepEqual(flagged, [1]);
  const row = await db.prepare('SELECT * FROM participations WHERE id = 1').first();
  assert.ok(row, 'the participation still exists -- this is not a delete');
  assert.equal(row.status, 'active', 'status is untouched -- every clipper-facing check still sees them as normal');
  assert.equal(row.inactive_at, NOW);
});

test('keeps a participation with a currently-linked account, however old', async () => {
  const db = seed({
    participations: [{ id: 1, clipper_id: 2, campaign_id: 1, status: 'active', joined_at: OVER_A_WEEK_AGO }],
    accounts: [{ id: 10, clipper_id: 2, platform: 'instagram', external_id: 'ig10', username: 'h',
                 access_token: 't', status: 'connected', connected_at: OVER_A_WEEK_AGO }],
    links: [{ id: 1, participation_id: 1, account_id: 10, platform: 'instagram', linked_at: OVER_A_WEEK_AGO }]
  });
  const flagged = await removeInactiveJoins(db, { now: NOW });
  assert.deepEqual(flagged, []);
  assert.equal((await db.prepare('SELECT inactive_at FROM participations WHERE id = 1').first()).inactive_at, null);
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
  const flagged = await removeInactiveJoins(db, { now: NOW });
  assert.deepEqual(flagged, []);
  assert.equal((await db.prepare('SELECT inactive_at FROM participations WHERE id = 1').first()).inactive_at, null);
});

test('leaves a recent joiner alone -- still inside the grace period', async () => {
  const db = seed({
    participations: [{ id: 1, clipper_id: 4, campaign_id: 1, status: 'active', joined_at: WITHIN_THE_WEEK }]
  });
  const flagged = await removeInactiveJoins(db, { now: NOW });
  assert.deepEqual(flagged, []);
});

test('never touches a paused or kicked participation, even if unconnected and old', async () => {
  const db = seed({
    participations: [
      { id: 1, clipper_id: 1, campaign_id: 1, status: 'paused', joined_at: OVER_A_WEEK_AGO },
      { id: 2, clipper_id: 2, campaign_id: 1, status: 'kicked', joined_at: OVER_A_WEEK_AGO }
    ]
  });
  const flagged = await removeInactiveJoins(db, { now: NOW });
  assert.deepEqual(flagged, []);
});

test('never re-flags (or re-logs) a participation already marked inactive', async () => {
  const db = seed({
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: OVER_A_WEEK_AGO, inactive_at: OVER_A_WEEK_AGO + 1000 }]
  });
  const flagged = await removeInactiveJoins(db, { now: NOW });
  assert.deepEqual(flagged, []);
});

test('logs an audit entry naming the clipper and campaign for each flag', async () => {
  const db = seed({
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: OVER_A_WEEK_AGO }]
  });
  await removeInactiveJoins(db, { now: NOW });
  const row = await db.prepare("SELECT * FROM staff_audit_log WHERE action = 'participation_marked_inactive'").first();
  assert.ok(row, 'an audit entry was written');
  assert.equal(row.staff_type, 'system');
  assert.equal(row.target_label, 'never_connected');
  assert.match(row.detail, /joined over a week ago, never connected/);
});

test('a mixed batch flags only the ones that actually qualify', async () => {
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
  const flagged = await removeInactiveJoins(db, { now: NOW });
  assert.deepEqual(flagged, [1]);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM participations').first()).n, 3, 'all three still exist');
});

test('connecting an account afterwards clears the flag automatically -- the actual reinstatement', async () => {
  const db = seed({
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: OVER_A_WEEK_AGO }],
    accounts: [{ id: 10, clipper_id: 1, platform: 'instagram', external_id: 'ig10', username: 'h',
                 access_token: 't', status: 'connected', connected_at: NOW }]
  });
  const flagged = await removeInactiveJoins(db, { now: NOW });
  assert.deepEqual(flagged, [1]);

  await linkParticipationAccount(db, 1, 10, 'instagram');

  const row = await db.prepare('SELECT * FROM participations WHERE id = 1').first();
  assert.equal(row.inactive_at, null, 'cleared the moment an account was connected -- no admin action, no re-join');
  assert.equal(row.status, 'active', 'was never anything else');
});
