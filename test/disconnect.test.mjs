// Disconnecting an account must do three things at once, and the money rule
// is the one that matters most: settled clips are financial history and
// survive untouched, pending clips are only tracking data and are wiped, and
// the participation link is actually released so a different account can be
// connected in its place (the bug that made "Disconnect" appear to do nothing).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disconnectSocialAccount } from '../src/db.js';

function makeDb({ accounts = [], submissions = [], participationAccounts = [], participations = [] } = {}) {
  const state = {
    social_accounts: accounts.map(a => ({ ...a })),
    submissions: submissions.map(s => ({ ...s })),
    participation_accounts: participationAccounts.map(p => ({ ...p })),
    participations: participations.map(p => ({ ...p }))
  };

  function first(sql, args) {
    if (/^SELECT \* FROM social_accounts WHERE id = \?/.test(sql)) {
      return state.social_accounts.find(a => a.id === args[0]) || null;
    }
    throw new Error('fake-db: unhandled first(): ' + sql);
  }

  function all(sql, args) {
    if (/^SELECT id, campaign_id, locked_at FROM submissions WHERE account_id = \?/.test(sql)) {
      return { results: state.submissions.filter(s => s.account_id === args[0]).map(s => ({ ...s })) };
    }
    throw new Error('fake-db: unhandled all(): ' + sql);
  }

  function run(sql, args) {
    if (/^DELETE FROM participation_accounts WHERE account_id = \?/.test(sql)) {
      state.participation_accounts = state.participation_accounts.filter(p => p.account_id !== args[0]);
      return { meta: {} };
    }
    if (/^UPDATE participations SET account_id = NULL WHERE account_id = \?/.test(sql)) {
      for (const p of state.participations) if (p.account_id === args[0]) p.account_id = null;
      return { meta: {} };
    }
    if (/^DELETE FROM submissions WHERE id IN/.test(sql)) {
      const ids = args;
      state.submissions = state.submissions.filter(s => !ids.includes(s.id));
      return { meta: {} };
    }
    if (/^UPDATE social_accounts SET status='revoked'/.test(sql)) {
      const a = state.social_accounts.find(x => x.id === args[0]);
      if (a) Object.assign(a, { status: 'revoked', access_token: null, refresh_token: null, token_expires_at: null });
      return { meta: {} };
    }
    if (/^DELETE FROM social_accounts WHERE id = \?/.test(sql)) {
      state.social_accounts = state.social_accounts.filter(a => a.id !== args[0]);
      return { meta: {} };
    }
    throw new Error('fake-db: unhandled run(): ' + sql);
  }

  return {
    prepare(sql) {
      let bound = [];
      const st = {
        bind: (...a) => { bound = a; return st; },
        first: async () => first(sql, bound),
        all: async () => all(sql, bound),
        run: async () => run(sql, bound)
      };
      return st;
    },
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
    _state: state
  };
}

const account = (o = {}) => ({ id: 3, clipper_id: 3, platform: 'youtube', username: '@testchannel', status: 'connected', access_token: 'tok', refresh_token: 'r', token_expires_at: 123, ...o });
const sub = (o = {}) => ({ id: 1, account_id: 3, campaign_id: 3, locked_at: null, ...o });

test('disconnect: deletes pending clips but keeps every settled one', async () => {
  const db = makeDb({
    accounts: [account()],
    submissions: [
      sub({ id: 1, locked_at: null }),
      sub({ id: 2, locked_at: null }),
      sub({ id: 3, locked_at: 1786492800000 })   // settled -- financial history
    ]
  });

  const r = await disconnectSocialAccount(db, 3);
  assert.equal(r.deleted_pending, 2);
  assert.equal(r.kept_settled, 1);
  assert.deepEqual(db._state.submissions.map(s => s.id), [3], 'only the settled clip remains');
});

test('disconnect: releases the participation link so a different account can be connected', async () => {
  const db = makeDb({
    accounts: [account()],
    participationAccounts: [{ participation_id: 6, account_id: 3, platform: 'youtube' }],
    participations: [{ id: 6, clipper_id: 3, campaign_id: 3, account_id: 3 }]
  });

  await disconnectSocialAccount(db, 3);
  assert.equal(db._state.participation_accounts.length, 0, 'the stale link that made this look still-connected is gone');
  assert.equal(db._state.participations[0].account_id, null);
});

test('disconnect: an account with NO clips is removed entirely', async () => {
  const db = makeDb({ accounts: [account()] });
  const r = await disconnectSocialAccount(db, 3);
  assert.equal(r.account_row_kept, false);
  assert.equal(db._state.social_accounts.length, 0);
});

test('disconnect: an account with settled clips keeps its row, stripped of credentials', async () => {
  const db = makeDb({
    accounts: [account()],
    submissions: [sub({ id: 1, locked_at: 1786492800000 })]
  });

  const r = await disconnectSocialAccount(db, 3);
  assert.equal(r.account_row_kept, true, 'settled history must still resolve to a real account row');
  const a = db._state.social_accounts[0];
  assert.equal(a.status, 'revoked');
  assert.equal(a.access_token, null);
  assert.equal(a.refresh_token, null, 'a stripped account must not keep a way to call the platform');
});

test('disconnect: reports every affected campaign so allocation can be re-run', async () => {
  const db = makeDb({
    accounts: [account()],
    submissions: [sub({ id: 1, campaign_id: 3 }), sub({ id: 2, campaign_id: 5 }), sub({ id: 3, campaign_id: 3 })]
  });
  const r = await disconnectSocialAccount(db, 3);
  assert.deepEqual(r.campaigns.sort(), [3, 5]);
});

test('disconnect: a missing account returns null rather than pretending it worked', async () => {
  const db = makeDb({ accounts: [] });
  assert.equal(await disconnectSocialAccount(db, 999), null);
});

test('disconnect: touches only the target account, never a sibling on another platform', async () => {
  const db = makeDb({
    accounts: [account({ id: 3, platform: 'youtube' }), account({ id: 4, platform: 'instagram', username: 'soza.clips' })],
    submissions: [sub({ id: 1, account_id: 3 }), sub({ id: 2, account_id: 4 })],
    participationAccounts: [
      { participation_id: 6, account_id: 3, platform: 'youtube' },
      { participation_id: 6, account_id: 4, platform: 'instagram' }
    ]
  });

  await disconnectSocialAccount(db, 3);
  assert.deepEqual(db._state.submissions.map(s => s.id), [2], "the other platform's clip is untouched");
  assert.deepEqual(db._state.participation_accounts.map(p => p.account_id), [4]);
  assert.ok(db._state.social_accounts.find(a => a.id === 4), 'the Instagram account is still connected');
});
