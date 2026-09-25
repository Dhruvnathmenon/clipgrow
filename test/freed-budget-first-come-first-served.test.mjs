// The rule for budget that comes back to a campaign (25 Sep 2026, Surya's clip on Mali): when a
// full campaign gets budget back -- clips flagged invalid give theirs up, or the budget is
// extended -- from that moment the freed money is spent first-come-first-served until it is
// used up.
//
// "First come" is the order clips reached ClipGrow. That includes clips that arrived while the
// campaign was full and were sitting at Rs 0: they are first in line for what comes back, ahead
// of anything that arrives after. The last clip to be funded takes only what is left. Everything
// behind it stays at Rs 0, and only THEN is "the campaign budget ran out" true for it.
//
// Uses the real routes, the real allocator and the real explanation, on the real schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';
import { reallocateCampaign } from '../src/earnings.js';
import { explainEarning, explainEarningText } from '../src/earning-math.js';
import { budgetLeftByCampaign } from '../src/db.js';

const NOW = Date.now();
const SECRET = 'test-secret';
const CPM = 50;

// Every clip below has 8,000 views: worth Rs 400 at cpm 50.
const clip = (id, arrivedMinutesAgo) => ({
  id, clipper_id: 1, campaign_id: 1, platform: 'instagram', ig_media_id: `m${id}`, permalink: `p${id}`,
  views: 8000, earning: 0, clipper_earning: 0, status: 'active', eligible: 1, source: 'auto',
  created_at: NOW - arrivedMinutesAgo * 60_000, posted_at: NOW - arrivedMinutesAgo * 60_000
});

function world() {
  return makeSqliteD1({
    clippers: [{ id: 1, username: 'surya', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'Mali', cpm: CPM, budget: 1000, status: 'active', created_at: NOW, min_views: 1000, allowed_platforms: 'instagram' }],
    // Arrival order A, B, C, D. Worth 400 each; the budget of 1,000 funds A, B and half of C.
    submissions: [clip(1, 50), clip(2, 40), clip(3, 30), clip(4, 20)]
  });
}
const env = (db) => ({ DB: db, SESSION_SECRET: SECRET, ADMIN_PASSWORD: 'x' });

async function extend(db, amount) {
  const cookie = await createSessionCookie('admin', 'admin', SECRET);
  const request = new Request('https://clipgrow.in/api/admin/campaigns/1/top-up', {
    method: 'POST', headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount })
  });
  const res = await handleAdmin(request, env(db), new URL(request.url));
  assert.equal(res.status, 201, 'the extension itself is accepted');
}
const earnings = (db) => Object.fromEntries(db._rows('submissions').map(s => [s.id, s.earning]));
const status = (db) => db._rows('campaigns')[0].status;

async function whatTheClipperSees(db, id) {
  const row = db._rows('submissions').find(s => s.id === id);
  const left = await budgetLeftByCampaign(db, [1]);
  const why = explainEarning(row, { cpm: CPM, minViews: 1000, budgetLeft: left.get(1) });
  return { reason: why.reason, text: explainEarningText(why) };
}

test('a full campaign funds clips in the order they arrived, and the last one gets only the remainder', async () => {
  const db = world();
  await reallocateCampaign(db, 1);

  assert.deepEqual(earnings(db), { 1: 400, 2: 400, 3: 200, 4: 0 });
  assert.equal(status(db), 'budget_full');

  // For D, at this moment, "the campaign budget ran out" is simply true.
  const d = await whatTheClipperSees(db, 4);
  assert.equal(d.reason, 'budget');
  assert.match(d.text, /budget ran out/);
});

test('extending the campaign spends the new money first-come-first-served, from that moment', async () => {
  const db = world();
  await reallocateCampaign(db, 1);                       // A 400, B 400, C 200, D 0

  await extend(db, 400);                                 // budget 1,400
  assert.deepEqual(earnings(db), { 1: 400, 2: 400, 3: 400, 4: 200 },
    'C is completed first, then D takes what is left: arrival order, not who complains');
  assert.equal(status(db), 'budget_full', 'still exactly full, so still closed to newcomers');

  await extend(db, 400);                                 // budget 1,800
  assert.deepEqual(earnings(db), { 1: 400, 2: 400, 3: 400, 4: 400 });
  assert.equal(status(db), 'active', 'and with room left over it opens again on its own');
});

test('a clip that arrived while the campaign was full is ahead of one that arrives after the extension', async () => {
  const db = world();
  await reallocateCampaign(db, 1);                       // D sits at Rs 0, the campaign is full
  await extend(db, 200);                                 // budget 1,200: exactly enough to finish C

  // E arrives AFTER the extension.
  db._sqlite.prepare(
    `INSERT INTO submissions (id, clipper_id, campaign_id, platform, ig_media_id, permalink, views, earning, clipper_earning, status, eligible, source, created_at, posted_at)
     VALUES (5, 1, 1, 'instagram', 'm5', 'p5', 8000, 0, 0, 'active', 1, 'auto', ?, ?)`
  ).run(NOW, NOW);
  await reallocateCampaign(db, 1);
  assert.deepEqual(earnings(db), { 1: 400, 2: 400, 3: 400, 4: 0, 5: 0 }, 'D and E both wait: nothing is left for either yet');

  await extend(db, 400);                                 // budget 1,600
  assert.deepEqual(earnings(db), { 1: 400, 2: 400, 3: 400, 4: 400, 5: 0 },
    'D, who arrived first and had been at Rs 0 the longest, is paid before E');

  await extend(db, 200);                                 // budget 1,800
  assert.deepEqual(earnings(db), { 1: 400, 2: 400, 3: 400, 4: 400, 5: 200 });
});

test('after an extension the clipper is told the truth at every step', async () => {
  const db = world();
  await reallocateCampaign(db, 1);

  // Behind the funded clips, budget spent: true.
  assert.equal((await whatTheClipperSees(db, 4)).reason, 'budget');

  await extend(db, 400);                                 // D is partly funded and the budget is spent to the rupee
  const partly = await whatTheClipperSees(db, 4);
  assert.equal(partly.reason, 'budget', 'partly funded because the money ran out again: true');
  assert.match(partly.text, /earned ₹200 of it/);

  await extend(db, 400);
  const paid = await whatTheClipperSees(db, 4);
  assert.equal(paid.reason, 'cpm', 'fully funded: just views x cpm, no excuse needed');
});

// The case behind the complaint: the price is simply behind. It must never read as "ran out".
test('a clip that has not been priced yet is never told the budget ran out while there is budget', async () => {
  const db = world();
  await reallocateCampaign(db, 1);
  await extend(db, 800);                                 // budget 1,800, everything funded, room for more

  // A new clip arrives and has not been priced yet.
  db._sqlite.prepare(
    `INSERT INTO submissions (id, clipper_id, campaign_id, platform, ig_media_id, permalink, views, earning, clipper_earning, status, eligible, source, created_at, posted_at)
     VALUES (9, 1, 1, 'instagram', 'm9', 'p9', 10797, 0, 0, 'active', 1, 'auto', ?, ?)`
  ).run(NOW, NOW);

  const seen = await whatTheClipperSees(db, 9);
  assert.equal(seen.reason, 'pending_price');
  assert.doesNotMatch(seen.text, /budget ran out/);

  await reallocateCampaign(db, 1);
  assert.equal(earnings(db)[9], 200, 'and the next pricing pass gives it what is left (Rs 200 of its Rs 539)');
});

// What actually happened on Mali: nobody added budget. Clips were flagged, gave their share back,
// and the clips waiting at Rs 0 should have been paid from it in arrival order.
async function flag(db, id) {
  const cookie = await createSessionCookie('admin', 'admin', SECRET);
  const request = new Request(`https://clipgrow.in/api/admin/submissions/${id}/invalidate`, {
    method: 'POST', headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'unrelated' })
  });
  const res = await handleAdmin(request, env(db), new URL(request.url));
  assert.equal(res.status, 200);
}

test('flagged clips give their budget back, and the clips waiting at Rs 0 are paid from it in arrival order', async () => {
  const db = world();
  await reallocateCampaign(db, 1);                       // A 400, B 400, C 200, D 0; full
  assert.equal(status(db), 'budget_full');

  await flag(db, 1);                                     // A is flagged: its 400 comes back
  assert.deepEqual(earnings(db), { 1: 0, 2: 400, 3: 400, 4: 200 },
    'C is completed first, then D (who was at Rs 0) takes the rest');
  assert.equal(status(db), 'budget_full', 'still exactly full');

  await flag(db, 2);                                     // B is flagged too: 400 more comes back
  assert.deepEqual(earnings(db), { 1: 0, 2: 0, 3: 400, 4: 400 });
  assert.equal(status(db), 'active', 'now there is room again, so it opens on its own');
});
