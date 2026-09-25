// Phase 0 of the bot integration: the tools every later phase is tested with.
//
// Nothing here touches the website. It proves that (1) the contract validator enforces exactly what
// Endrig's documents say, and (2) the fake bot answers as those documents say, including the ways a
// real listener on someone else's machine fails. If either is wrong, every later test built on them
// proves nothing, so they are checked first and checked hard.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateNotify, validateLink, validateCampaignSync, forumCampaignProblems, forumListProblems,
  normaliseStatus, threadTitle, LIMITS, SNOWFLAKE
} from './helpers/bot-contract.mjs';
import { startFakeBot } from './helpers/fake-bot.mjs';

const ID = '111111111111111111';
const doc = name => readFileSync(new URL(`../docs/endrig/${name}`, import.meta.url), 'utf8');

/* ------------------------------------------- the documents are what we tested against */

test('the rules encoded here still match the documents they came from', () => {
  const notify = doc('bot-notify-contract.md');
  for (const t of ['submission_approved', 'submission_rejected', 'payout_sent', 'custom']) assert.ok(notify.includes('`' + t + '`'), `notify doc no longer lists ${t}`);
  assert.match(notify, /title`\)?\s*\|\s*yes\s*\|\s*max 256 chars/i, 'custom title limit changed');
  assert.match(notify, /description`\s*\|\s*yes\s*\|\s*max 4096 chars/i, 'custom description limit changed');
  assert.match(notify, /within 30 minutes/i, 'the event_id window changed');
  assert.match(notify, /2\.5 seconds/i, 'the batching window changed');
  assert.match(doc('bot-link-contract.md'), /"access_token"/);
  assert.match(doc('bot-campaign-forum-contract.md'), /POST \/campaign-sync|\/campaign-sync/);
  assert.equal(LIMITS.title, 256);
  assert.equal(LIMITS.description, 4096);
});

/* --------------------------------------------------------------- /notify rules */

const good = {
  submission_approved: { type: 'submission_approved', discord_user_id: ID, campaign: 'Test Campaign', views: 1000 },
  submission_rejected: { type: 'submission_rejected', discord_user_id: ID, campaign: 'Test Campaign', reason: 'The audio is out of sync.' },
  payout_sent: { type: 'payout_sent', discord_user_id: ID, amount_inr: 1250.5 },
  custom: { type: 'custom', discord_user_id: ID, title: 'Hello', description: 'Body **text**' }
};

test('the example in the document is accepted, and so is each type with only its required fields', () => {
  for (const [type, body] of Object.entries(good)) assert.deepEqual(validateNotify(body), { ok: true }, type);
  assert.deepEqual(validateNotify({ ...good.submission_approved, event_id: 'submission_8231_approved' }), { ok: true });
});

test('every optional field is accepted when it is right', () => {
  assert.equal(validateNotify({ ...good.submission_approved, platform: 'YouTube', clip_url: 'https://youtu.be/x' }).ok, true);
  assert.equal(validateNotify({ ...good.submission_rejected, resubmit_url: 'https://clipgrow.in/dashboard' }).ok, true);
  assert.equal(validateNotify({ ...good.payout_sent, campaign: 'C', method: 'UPI', note: 'Ref 123' }).ok, true);
  for (const color of ['#5865f2', '5865f2', 0x5865f2, 0]) assert.equal(validateNotify({ ...good.custom, color }).ok, true, String(color));
});

test('a bad snowflake is bad_snowflake, with a message that says what to send', () => {
  for (const bad of [undefined, null, '', 'abc', '123', '1'.repeat(16), '1'.repeat(21), 111111111111111111, ' 111111111111111111', '1111111111111111a1']) {
    const r = validateNotify({ ...good.custom, discord_user_id: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.error, 'bad_snowflake');
    assert.match(r.message, /discord_user_id/);
  }
  assert.ok(SNOWFLAKE.test('973051075991052339'), 'a real id from the bot repository passes');
});

test('an unknown or missing type is bad_request, naming the accepted ones', () => {
  for (const type of [undefined, null, '', 'nope', 'SUBMISSION_APPROVED', 5]) {
    const r = validateNotify({ ...good.custom, type });
    assert.equal(r.ok, false, String(type));
    assert.equal(r.error, 'bad_request');
    assert.match(r.message, /submission_approved.*payout_sent/);
  }
});

test('each type refuses what it requires and says exactly which field', () => {
  const cases = [
    [{ ...good.submission_approved, campaign: undefined }, /campaign is required/],
    [{ ...good.submission_approved, campaign: '   ' }, /campaign is required/],
    [{ ...good.submission_approved, campaign: 5 }, /campaign is required/],
    [{ ...good.submission_approved, views: -1 }, /views/],
    [{ ...good.submission_approved, views: '1000' }, /views/],
    [{ ...good.submission_approved, clip_url: 'not a link' }, /clip_url/],
    [{ ...good.submission_approved, clip_url: 'javascript:alert(1)' }, /clip_url/],
    [{ ...good.submission_rejected, reason: undefined }, /reason is required/],
    [{ ...good.submission_rejected, reason: '' }, /reason is required/],
    [{ ...good.submission_rejected, campaign: undefined }, /campaign is required/],
    [{ ...good.submission_rejected, resubmit_url: 'x' }, /resubmit_url/],
    [{ ...good.payout_sent, amount_inr: undefined }, /amount_inr/],
    [{ ...good.payout_sent, amount_inr: '1250' }, /amount_inr/],
    [{ ...good.payout_sent, amount_inr: 0 }, /amount_inr/],
    [{ ...good.payout_sent, amount_inr: -5 }, /amount_inr/],
    [{ ...good.payout_sent, amount_inr: NaN }, /amount_inr/],
    [{ ...good.payout_sent, amount_inr: Infinity }, /amount_inr/],
    [{ ...good.custom, title: undefined }, /title is required/],
    [{ ...good.custom, description: undefined }, /description is required/],
    [{ ...good.custom, color: 'blue' }, /color/],
    [{ ...good.custom, color: 0x1000000 }, /color/]
  ];
  for (const [body, message] of cases) {
    const r = validateNotify(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(r.error, 'bad_request');
    assert.match(r.message, message, JSON.stringify(body));
  }
});

test('the documented length limits are exact: 256 and 4096 pass, one more fails', () => {
  assert.equal(validateNotify({ ...good.custom, title: 'x'.repeat(256) }).ok, true);
  assert.equal(validateNotify({ ...good.custom, title: 'x'.repeat(257) }).ok, false);
  assert.equal(validateNotify({ ...good.custom, description: 'x'.repeat(4096) }).ok, true);
  assert.equal(validateNotify({ ...good.custom, description: 'x'.repeat(4097) }).ok, false);
  assert.equal(validateNotify({ ...good.payout_sent, note: 'x'.repeat(1025) }).ok, false, 'DISCORD field limit on the free-text fields');
  assert.equal(validateNotify({ ...good.submission_approved, event_id: 'e'.repeat(129) }).ok, false);
});

test('a body that is not an object is refused, never thrown on', () => {
  for (const body of [null, undefined, [], 'str', 5, true]) {
    const r = validateNotify(body);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'bad_request');
  }
});

test('/link and /campaign-sync rules', () => {
  assert.equal(validateLink({ discord_user_id: ID, access_token: 'a-real-looking-access-token' }).ok, true);
  assert.equal(validateLink({ discord_user_id: 'x', access_token: 'a-real-looking-access-token' }).error, 'bad_snowflake');
  assert.equal(validateLink({ discord_user_id: ID }).error, 'bad_access_token');
  assert.equal(validateLink({ discord_user_id: ID, access_token: '' }).error, 'bad_access_token');
  assert.equal(validateLink(null).ok, false);
  assert.equal(validateCampaignSync({}).ok, true, 'an empty body works, as the document says');
  assert.equal(validateCampaignSync({ campaign_id: 42 }).ok, true);
  for (const bad of [{ campaign_id: 'x' }, { campaign_id: -1 }, { campaign_id: 1.5 }, { campaign_id: 0 }]) assert.equal(validateCampaignSync(bad).ok, false, JSON.stringify(bad));
  assert.equal(validateCampaignSync(null).ok, false);
});

/* ------------------------------------------------------- forum: what we will send */

test('status words are read the way the forum contract says', () => {
  for (const s of ['paused', 'pause', 'on_hold', 'hold', 'PAUSED', ' Hold ']) assert.equal(normaliseStatus(s), 'paused', s);
  for (const s of ['over', 'closed', 'ended', 'complete', 'completed', 'finished', 'OVER']) assert.equal(normaliseStatus(s), 'over', s);
  for (const s of ['live', 'active', '', undefined, null, 'budget_full', 7]) assert.equal(normaliseStatus(s), 'live', String(s));
});

test('the thread title is "<emoji> <name> (<STATUS>)", with 📋 when there is no emoji', () => {
  assert.equal(threadTitle({ emoji: '🎙️', name: 'Be10x', status: 'live' }), '🎙️ Be10x (LIVE)');
  assert.equal(threadTitle({ name: 'Be10x', status: 'paused' }), '📋 Be10x (PAUSED)');
  assert.equal(threadTitle({ emoji: '  ', name: 'Be10x', status: 'completed' }), '📋 Be10x (OVER)');
});

const fullCampaign = {
  id: 1, name: 'Be10x', cpm: 70, min_views: 1000, platforms: ['instagram', 'youtube'], status: 'live', emoji: '🎙️',
  logo_url: 'https://clipgrow.in/logo.png', budget_total: 50000, budget_consumed: 17600, clippers_enrolled: 14, max_payout_per_video: 2000,
  cta: ['Follow @be10x'], payout_note: 'Only approved views count.', dos: ['Use real footage'], donts: ["Don't add claims"],
  important_note: 'Quality over volume.', help_text: 'Ask in <#123456789012345678>', apply_url: 'https://clipgrow.in/dashboard'
};

test('a complete forum campaign, and the minimal one the website sends today, are both fine', () => {
  assert.deepEqual(forumCampaignProblems(fullCampaign), []);
  assert.deepEqual(forumCampaignProblems({ id: 1, name: 'Reel Rush', cpm: 55, min_views: 1000, platforms: ['instagram'] }), []);
  assert.deepEqual(forumListProblems({ campaigns: [fullCampaign, { ...fullCampaign, id: 2, name: 'Other' }] }), []);
});

test('forum campaigns that would break the post are caught', () => {
  const cases = [
    [{ ...fullCampaign, id: 0 }, /id/],
    [{ ...fullCampaign, id: '1' }, /id/],
    [{ ...fullCampaign, name: '' }, /name is required/],
    [{ ...fullCampaign, status: 'budget_full' }, /live, paused or over/],
    [{ ...fullCampaign, logo_url: 'http://clipgrow.in/logo.png' }, /https/],
    [{ ...fullCampaign, logo_url: 'nope' }, /logo_url/],
    [{ ...fullCampaign, budget_total: -1 }, /budget_total/],
    [{ ...fullCampaign, budget_consumed: 60000 }, /negative/],
    [{ ...fullCampaign, clippers_enrolled: 1.5 }, /whole number/],
    [{ ...fullCampaign, cta: 'one string' }, /cta must be a list/],
    [{ ...fullCampaign, dos: Array(26).fill('x') }, /more than 25/],
    [{ ...fullCampaign, donts: ['x'.repeat(1025)] }, /over 1024/],
    [{ ...fullCampaign, important_note: 'x'.repeat(1025) }, /important_note is over/],
    [{ ...fullCampaign, name: 'N'.repeat(95) }, /thread title/],
    [{ ...fullCampaign, source_footage_link: 'not a url' }, /source_footage_link/],
    [{ ...fullCampaign, help_text: 5 }, /help_text/]
  ];
  for (const [c, message] of cases) assert.match(forumCampaignProblems(c).join(' | '), message, JSON.stringify(c).slice(0, 80));
  assert.match(forumCampaignProblems({ ...fullCampaign, dos: Array(20).fill('x'.repeat(400)), donts: Array(20).fill('y'.repeat(400)) }).join(' '), /one Discord embed holds/);
  assert.match(forumListProblems({ campaigns: [fullCampaign, fullCampaign] }).join(' '), /appears twice/);
  assert.deepEqual(forumListProblems(null).length, 1);
  assert.deepEqual(forumListProblems({}).length, 1);
});

/* ---------------------------------------------------------------- the fake bot */

const bots = [];
const newBot = async opts => { const b = await startFakeBot(opts); bots.push(b); return b; };
after(async () => { await Promise.all(bots.map(b => b.close())); });

async function call(bot, path, { method = 'POST', body, raw, token = bot.token, headers = {}, signal } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (token !== null) h.Authorization = `Bearer ${token}`;
  const res = await fetch(bot.url + path, { method, headers: h, body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)), signal });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

test('fake bot: 401 for a missing, wrong or malformed token, and nothing is queued', async () => {
  const bot = await newBot();
  for (const token of [null, 'wrong', '', bot.token + 'x']) {
    const r = await call(bot, '/notify', { body: good.custom, token });
    assert.equal(r.status, 401, String(token));
    assert.deepEqual(r.json, { ok: false, error: 'unauthorized' });
  }
  const noBearer = await call(bot, '/notify', { body: good.custom, token: null, headers: { Authorization: bot.token } });
  assert.equal(noBearer.status, 401, 'the token without "Bearer " is refused');
  assert.equal(bot.notifications.length, 0);
  assert.equal((await call(bot, '/link', { body: {}, token: 'wrong' })).status, 401);
  assert.equal((await call(bot, '/campaign-sync', { body: {}, token: 'wrong' })).status, 401);
});

test('fake bot /notify: accepted, validated, and de-duplicated by event_id for 30 minutes', async () => {
  let clock = 1_000_000;
  const bot = await newBot({ now: () => clock });
  const body = { ...good.submission_approved, event_id: 'submission_1_approved' };

  let r = await call(bot, '/notify', { body });
  assert.equal(r.status, 202);
  assert.deepEqual(r.json, { ok: true, queued: true, duplicate: false });

  r = await call(bot, '/notify', { body });
  assert.equal(r.status, 202);
  assert.deepEqual(r.json, { ok: true, queued: false, duplicate: true });
  assert.equal(bot.notifications.length, 1, 'the repeat was dropped, so the person is not told twice');

  clock += 29 * 60 * 1000;
  assert.equal((await call(bot, '/notify', { body })).json.duplicate, true, 'still inside the window');
  clock += 2 * 60 * 1000;
  assert.equal((await call(bot, '/notify', { body })).json.duplicate, false, '31 minutes on it is a new event');
  assert.equal(bot.notifications.length, 2);

  const noId = { ...good.custom };
  await call(bot, '/notify', { body: noId }); await call(bot, '/notify', { body: noId });
  assert.equal(bot.notifications.filter(n => n.title === 'Hello').length, 2, 'without an event_id nothing is de-duplicated');
});

test('fake bot /notify: a bad payload is a 400 with the code and the reason', async () => {
  const bot = await newBot();
  let r = await call(bot, '/notify', { body: { ...good.submission_rejected, reason: undefined } });
  assert.equal(r.status, 400);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'bad_request');
  assert.match(r.json.message, /reason is required/);
  r = await call(bot, '/notify', { body: { ...good.custom, discord_user_id: '12' } });
  assert.equal(r.json.error, 'bad_snowflake');
  r = await call(bot, '/notify', { raw: '{not json' });
  assert.equal(r.status, 400);
  assert.match(r.json.message, /valid JSON/);
  r = await call(bot, '/notify', { raw: '[]' });
  assert.equal(r.status, 400);
  assert.equal(bot.notifications.length, 0);
});

test('fake bot: unknown paths are 404 and wrong methods are 405', async () => {
  const bot = await newBot();
  assert.equal((await call(bot, '/nope')).status, 404);
  assert.equal((await call(bot, '/api/bot/ping', { method: 'POST' })).status, 404);
  for (const path of ['/notify', '/link', '/campaign-sync']) {
    assert.equal((await call(bot, path, { method: 'GET' })).status, 405, `GET ${path}`);
    assert.equal((await call(bot, path, { method: 'PUT', body: {} })).status, 405, `PUT ${path}`);
  }
});

test('fake bot /link: every documented reply', async () => {
  const body = { discord_user_id: ID, access_token: 'a-real-looking-access-token' };
  const expected = {
    joined: [200, { ok: true, joined: true, alreadyMember: false }],
    already: [200, { ok: true, joined: false, alreadyMember: true }],
    guild_unavailable: [500, { ok: false, error: 'guild_unavailable' }],
    discord_error: [502, { ok: false, error: 'discord_error' }]
  };
  for (const [linkResult, [status, json]] of Object.entries(expected)) {
    const bot = await newBot({ linkResult });
    const r = await call(bot, '/link', { body });
    assert.equal(r.status, status, linkResult);
    assert.deepEqual(r.json, json, linkResult);
  }
  const rejected = await call(await newBot({ linkResult: 'discord_rejected' }), '/link', { body });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.json.error, 'discord_rejected');
  assert.match(rejected.json.message, /expired/);

  const bot = await newBot();
  assert.equal((await call(bot, '/link', { body: { discord_user_id: ID } })).json.error, 'bad_access_token');
  assert.equal((await call(bot, '/link', { body: { access_token: 'a-real-looking-access-token' } })).json.error, 'bad_snowflake');
  await call(bot, '/link', { body });
  assert.ok(!JSON.stringify(bot.links).includes('access-token'), 'the fake, like the real bot, does not keep the token');
});

test('fake bot /campaign-sync: 202 when the forum is on, 200 not_configured when it is not, {} is enough', async () => {
  const on = await newBot();
  let r = await call(on, '/campaign-sync', { body: {} });
  assert.equal(r.status, 202);
  assert.deepEqual(r.json, { ok: true, triggered: true });
  r = await call(on, '/campaign-sync', { body: { campaign_id: 42 } });
  assert.equal(r.status, 202);
  r = await call(on, '/campaign-sync', {});
  assert.equal(r.status, 202, 'no body at all works too');
  assert.equal(on.syncs, 3);
  assert.equal((await call(on, '/campaign-sync', { body: { campaign_id: 'x' } })).status, 400);

  const off = await newBot({ forumConfigured: false });
  r = await call(off, '/campaign-sync', { body: {} });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, triggered: false, reason: 'not_configured' });
  assert.equal(off.syncs, 0);
});

test('fake bot misbehaves on demand, then recovers: 500, an HTML error page, dropped, bad JSON', async () => {
  const bot = await newBot();

  bot.failNext(2, 'error500');
  assert.deepEqual([(await call(bot, '/notify', { body: good.custom })).status, (await call(bot, '/notify', { body: good.custom })).status], [500, 500]);
  assert.equal((await call(bot, '/notify', { body: good.custom })).status, 202, 'recovers on its own after two');

  bot.failNext(1, 'html502');
  const html = await call(bot, '/notify', { body: good.custom });
  assert.equal(html.status, 502);
  assert.equal(html.json, null, 'a proxy page is not JSON, and the client must cope with that');
  assert.match(html.text, /Bad Gateway/);

  bot.failNext(1, 'badjson');
  const bad = await call(bot, '/notify', { body: good.custom });
  assert.equal(bad.status, 200);
  assert.equal(bad.json, null, 'a 200 whose body is not JSON');

  bot.failNext(1, 'drop');
  await assert.rejects(call(bot, '/notify', { body: good.custom }), 'a dropped connection is a network error, not a status');
  assert.equal(bot.requests.at(-1).status, 'dropped');

  bot.mode = 'error500';
  assert.equal((await call(bot, '/link', { body: {} })).status, 500);
  bot.mode = 'ok';
  assert.equal((await call(bot, '/notify', { body: good.custom })).status, 202);
});

test('fake bot: a hang never answers, so a caller must time out; a slow bot answers late', async () => {
  const bot = await newBot({ delayMs: 250 });

  bot.mode = 'hang';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 300);
  await assert.rejects(call(bot, '/notify', { body: good.custom, signal: ctl.signal }), /abort/i);
  clearTimeout(timer);
  assert.equal(bot.requests.at(-1).status, 'hung');

  bot.mode = 'slow';
  const t0 = Date.now();
  const r = await call(bot, '/notify', { body: good.custom });
  assert.equal(r.status, 202);
  assert.ok(Date.now() - t0 >= 240, 'answered only after the delay');
  bot.mode = 'ok';
});

test('fake bot records what it was sent, in order, so a test can assert on the exact call', async () => {
  const bot = await newBot();
  await call(bot, '/notify', { body: { ...good.custom, event_id: 'a' } });
  await call(bot, '/campaign-sync', { body: {} });
  assert.deepEqual(bot.requests.map(r => [r.method, r.path, r.status]), [['POST', '/notify', 202], ['POST', '/campaign-sync', 202]]);
  assert.equal(bot.requests[0].headers.authorization, `Bearer ${bot.token}`);
  assert.equal(bot.requests[0].body.event_id, 'a');
  bot.reset();
  assert.equal(bot.requests.length, 0);
});
