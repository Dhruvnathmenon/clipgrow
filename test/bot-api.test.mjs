// The bot API: the one door the Discord bot uses to ask ClipGrow anything.
//
// The bot host is outside ClipGrow's control, so these tests are written from the
// point of view of a caller that might not be friendly: what it can learn, what it
// cannot, and what happens when it sends nonsense, hammers the endpoint, or the
// database underneath misbehaves. The happy path is the smaller half.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleBot, INTENTS, BOT_LIMITS, safe, campaignLine, botTokenOk } from '../src/bot-api.js';
import { COMPLETE_PROFILE } from './helpers/profile.mjs';
import worker from '../src/worker.js';

const NOW = Date.now();
const TOKEN = 'a-long-random-bot-token-for-tests';
const RAVI = '111111111111111111';
const ASHA = '222222222222222222';

function world(extra = {}) {
  const base = { password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW, ...COMPLETE_PROFILE };
  return {
    DB: makeSqliteD1({
      clippers: [
        { id: 1, ...base, username: 'ravi', display_name: 'Ravi', discord_user_id: RAVI, discord_handle: 'ravi.k' },
        { id: 2, ...base, username: 'asha', display_name: 'Asha', discord_user_id: ASHA, discord_handle: 'asha_s' },
        { id: 3, ...base, username: 'nolink', display_name: 'Nolink' }
      ],
      campaigns: [
        { id: 1, name: 'Reel Rush', description: 'secret brief', cpm: 55, budget: 90000, status: 'active', created_at: NOW, model: 'cpm', min_views: 1000, allowed_platforms: 'instagram,youtube' },
        { id: 2, name: 'Mali Music', description: '', cpm: 40, budget: 50000, status: 'active', created_at: NOW - 1, model: 'cpm', min_views: 0, allowed_platforms: 'instagram' },
        { id: 3, name: 'Old Campaign', description: '', cpm: 30, budget: 1000, status: 'completed', created_at: NOW - 2, model: 'cpm', min_views: 0, allowed_platforms: 'instagram' }
      ],
      ...extra
    }),
    SESSION_SECRET: 'test-secret',
    BOT_API_TOKEN: TOKEN
  };
}

function req(path, { method = 'GET', body, token = TOKEN, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  return new Request(`https://clipgrow.in${path}`, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
}
const call = (env, path, opts) => { const r = req(path, opts); return handleBot(r, env, new URL(r.url)); };
const ask = (env, discord_user_id, intent = 'status', opts = {}) => call(env, '/api/bot/answer', { method: 'POST', body: { discord_user_id, intent }, ...opts });
const lines = async res => (await res.json()).lines.join('\n');

/* -------------------------------------------------------------------- auth */

test('off until a token exists: nothing answers, and it says why', async () => {
  const env = world(); delete env.BOT_API_TOKEN;
  const res = await call(env, '/api/bot/ping');
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'bot_api_disabled');
});

test('a missing, malformed or wrong token is refused, and nothing is read', async () => {
  const env = world();
  for (const opts of [
    { token: null },
    { token: 'wrong' },
    { token: TOKEN.slice(0, -1) },                 // one character short
    { token: TOKEN + 'x' },                        // one character long
    { token: '', headers: { Authorization: 'Bearer ' } },
    { token: null, headers: { Authorization: TOKEN } },              // no "Bearer"
    { token: null, headers: { Authorization: `Basic ${TOKEN}` } }
  ]) {
    const res = await call(env, '/api/bot/campaigns', opts);
    assert.equal(res.status, 401, JSON.stringify(opts));
    assert.equal((await res.json()).error, 'unauthorized');
  }
  assert.equal(env.DB._sqlite.prepare('SELECT COUNT(*) n FROM bot_api_calls').get().n, 0, 'a refused caller does not even reach the log');
});

test('the right token works, whatever the case of the scheme word', async () => {
  const env = world();
  assert.equal((await call(env, '/api/bot/ping')).status, 200);
  assert.equal((await call(env, '/api/bot/ping', { token: null, headers: { Authorization: `bearer ${TOKEN}` } })).status, 200);
  assert.equal(await botTokenOk(req('/x', { token: TOKEN }), { BOT_API_TOKEN: TOKEN }), true);
  assert.equal(await botTokenOk(req('/x', { token: TOKEN }), {}), false, 'no configured token never matches anything');
});

test('paths and methods outside the contract are refused cleanly', async () => {
  const env = world();
  assert.equal(await call(env, '/api/clipper/me'), null, 'not ours: the router carries on to the next handler');
  assert.equal((await call(env, '/api/bot/nonsense')).status, 404);
  assert.equal((await call(env, '/api/bot/answer', { method: 'GET' })).status, 405);
  assert.equal((await call(env, '/api/bot/campaigns', { method: 'POST', body: {} })).status, 405);
  assert.equal((await call(env, '/api/bot/ping', { method: 'DELETE' })).status, 405);
});

/* ------------------------------------------------------------- bad input */

test('malformed requests are a 400 with a reason, never a crash', async () => {
  const env = world();
  const bad = [
    ['not json at all', 'bad_request'],
    ['[]', 'bad_request'],
    ['null', 'bad_request'],
    [{}, 'bad_request'],
    [{ intent: 'status' }, 'bad_request'],
    [{ discord_user_id: 12345678901234567, intent: 'status' }, 'bad_request'],   // a number, not a string
    [{ discord_user_id: '123', intent: 'status' }, 'bad_request'],
    [{ discord_user_id: '1'.repeat(40), intent: 'status' }, 'bad_request'],
    [{ discord_user_id: 'abc' + RAVI, intent: 'status' }, 'bad_request'],
    [{ discord_user_id: `${RAVI}' OR 1=1 --`, intent: 'status' }, 'bad_request'],
    [{ discord_user_id: RAVI }, 'unknown_intent'],
    [{ discord_user_id: RAVI, intent: 'earnings' }, 'unknown_intent'],
    [{ discord_user_id: RAVI, intent: 'STATUS' }, 'unknown_intent'],
    [{ discord_user_id: RAVI, intent: ['status'] }, 'unknown_intent'],
    [{ discord_user_id: RAVI, intent: { $ne: null } }, 'unknown_intent']
  ];
  for (const [body, code] of bad) {
    const res = await call(env, '/api/bot/answer', { method: 'POST', body });
    assert.equal(res.status, 400, JSON.stringify(body));
    const out = await res.json();
    assert.equal(out.error, code, JSON.stringify(body));
    assert.equal(typeof out.message, 'string');
  }
});

test('the only questions on offer are the ones written down', () => {
  assert.deepEqual(INTENTS, ['status'], 'a new question is a deliberate change here, reviewed, not something the bot can add');
});

/* -------------------------------------------------------------- the answer */

test('an unlinked Discord account gets a pointer, and learns nothing about anyone', async () => {
  const env = world();
  const res = await ask(env, '999999999999999999');
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.linked, false);
  const text = out.lines.join('\n');
  assert.match(text, /Connect Discord/);
  for (const secret of ['Ravi', 'Asha', 'Reel Rush', 'ravi']) assert.equal(text.includes(secret), false, secret);
});

test('a deleted account is indistinguishable from one that was never linked', async () => {
  const env = world();
  env.DB._sqlite.prepare("UPDATE clippers SET status = 'deleted' WHERE id = 1").run();
  const out = await (await ask(env, RAVI)).json();
  assert.equal(out.linked, false);
});

test('status tells a linked clipper where they stand, and only them', async () => {
  const env = world({
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW }, { id: 2, clipper_id: 2, campaign_id: 2, status: 'active', joined_at: NOW }],
    campaign_applications: [{ clipper_id: 1, campaign_id: 1, attempt: 1, status: 'pending', created_at: NOW }]
  });
  const mine = await lines(await ask(env, RAVI));
  assert.match(mine, /Signed in as \*\*Ravi\*\*/);
  assert.match(mine, /Reel Rush\*\* — ⏳ video waiting/);
  assert.equal(mine.includes('Mali Music'), false, 'campaigns not joined are counted, not named...');
  assert.match(mine, /1 more campaign is open/);
  assert.equal(mine.includes('Asha'), false, '...but Asha, and what she is doing, never appears');
  const hers = await lines(await ask(env, ASHA));
  assert.equal(hers.includes('Reel Rush**'), false);
  assert.match(hers, /Mali Music\*\* — ➡️ next: send your video/);
});

test('every step of the journey reads correctly', () => {
  const app = (state, extra = {}) => ({ state, attempts_left: 3, ...extra });
  const line = o => campaignLine({ name: 'C', participation: 'active', app: app('none'), connected: false, needsReconnect: false, campaignStatus: 'active', ...o });
  assert.match(line({}), /send your video/);
  assert.match(line({ app: app('pending') }), /waiting for a reviewer/);
  assert.match(line({ app: app('approved') }), /connect the account/);
  assert.match(line({ app: app('rejected', { attempts_left: 2 }) }), /changes needed \(2 tries left\)/);
  assert.match(line({ app: app('rejected', { attempts_left: 1 }) }), /\(1 try left\)/);
  assert.match(line({ app: app('exhausted') }), /not approved after 3 tries/);
  assert.match(line({ app: app('approved'), connected: true }), /✅ live/);
  assert.match(line({ app: app('approved'), connected: true, needsReconnect: true }), /needs reconnecting/);
  assert.match(line({ participation: 'kicked' }), /removed/);
  assert.match(line({ campaignStatus: 'budget_full' }), /closed to new clippers/);
});

test('the reviewer\'s note and the video link never leave the website', async () => {
  const env = world({
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW }],
    campaign_applications: [{ clipper_id: 1, campaign_id: 1, attempt: 1, status: 'rejected', reviewer_note: 'PRIVATE-NOTE-XYZ', video_url: 'https://drive.google.com/PRIVATE-URL', created_at: NOW }]
  });
  const text = await lines(await ask(env, RAVI));
  assert.match(text, /changes needed/);
  assert.equal(text.includes('PRIVATE-NOTE-XYZ'), false);
  assert.equal(text.includes('PRIVATE-URL'), false);
});

test('a live campaign and one that needs reconnecting are told apart', async () => {
  const env = world({
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW }, { id: 2, clipper_id: 1, campaign_id: 2, status: 'active', joined_at: NOW }],
    campaign_applications: [
      { clipper_id: 1, campaign_id: 1, attempt: 1, status: 'approved', created_at: NOW },
      { clipper_id: 1, campaign_id: 2, attempt: 1, status: 'approved', created_at: NOW }
    ],
    social_accounts: [
      { id: 1, clipper_id: 1, platform: 'instagram', external_id: 'a', username: 'a', status: 'connected', connected_at: NOW },
      { id: 2, clipper_id: 1, platform: 'instagram', external_id: 'b', username: 'b', status: 'needs_reauth', connected_at: NOW }
    ],
    participation_accounts: [
      { participation_id: 1, account_id: 1, platform: 'instagram', linked_at: NOW },
      { participation_id: 2, account_id: 2, platform: 'instagram', linked_at: NOW }
    ]
  });
  const text = await lines(await ask(env, RAVI));
  assert.match(text, /Mali Music\*\* — ⚠️ live, but an account needs reconnecting/);
  assert.match(text, /Reel Rush\*\* — ✅ live/);
});

test('missing details are named, present ones are not', async () => {
  const env = world();
  env.DB._sqlite.prepare("UPDATE clippers SET upi_id = NULL, contact_number = NULL WHERE id = 1").run();
  const text = await lines(await ask(env, RAVI));
  assert.match(text, /Details needed: contact number, UPI ID/);
  assert.equal(text.includes('9876543210'), false);
  assert.match(await lines(await ask(env, ASHA)), /details are complete/);
});

test('a disabled account is told so, without a campaign list', async () => {
  const env = world({ participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW }] });
  env.DB._sqlite.prepare("UPDATE clippers SET status = 'disabled' WHERE id = 1").run();
  const text = await lines(await ask(env, RAVI));
  assert.match(text, /disabled/);
  assert.equal(text.includes('Reel Rush'), false);
});

test('an ended campaign drops out of the list', async () => {
  const env = world({ participations: [{ id: 1, clipper_id: 1, campaign_id: 3, status: 'active', joined_at: NOW }] });
  const text = await lines(await ask(env, RAVI));
  assert.equal(text.includes('Old Campaign'), false);
  assert.match(text, /haven't joined a campaign yet/);
});

test('no money, anywhere: not in the words, not in the fields', async () => {
  const env = world({
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW }],
    campaign_applications: [{ clipper_id: 1, campaign_id: 1, attempt: 1, status: 'approved', created_at: NOW }],
    submissions: []
  });
  for (const res of [await ask(env, RAVI), await call(env, '/api/bot/campaigns')]) {
    const raw = JSON.stringify(await res.json());
    assert.equal(/₹|\brs\.?\b|rupee|earn|paid|owed|budget|spent|remaining|balance|payout/i.test(raw), false, raw);
    assert.equal(raw.includes('90000'), false, 'the campaign budget');
    assert.equal(raw.includes('secret brief'), false, 'the campaign description');
    for (const v of ['upi', 'email', 'legal', 'test@example.com', 'testuser@okbank']) assert.equal(raw.toLowerCase().includes(v), false, v);
  }
});

/* ------------------------------------------- what an admin or clipper typed */

test('names cannot ping a channel or break the formatting', () => {
  assert.equal(safe('@everyone'), '@​everyone');
  assert.equal(safe('@here and <@123>'), '@\u200bhere and <@\u200b123\\>', 'the @ is broken so it cannot become a mention; > is escaped like any markdown');
  assert.equal(safe('**bold** _it_ `code` ~~x~~ ||spoiler|| # h > q [l](u)').includes('*'), true);
  assert.equal(/(^|[^\\])[*_`~|]/.test(safe('**bold** _it_ `code` ~~x~~ ||spoiler||')), false, 'every markdown character is escaped');
  assert.equal(safe('line one\nline two\r\nline three'), 'line one line two line three');
  assert.equal(safe('x'.repeat(500)).length, 80);
  assert.equal(safe(null), '');
  assert.equal(safe(undefined), '');
  assert.equal(safe(12345), '12345');
});

test('a hostile campaign or clipper name is neutralised in every place it can appear', async () => {
  const evil = '@everyone **click** [here](http://evil.example)';
  const env = world({ participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW }] });
  env.DB._sqlite.prepare('UPDATE campaigns SET name = ? WHERE id = 1').run(evil);
  env.DB._sqlite.prepare('UPDATE clippers SET display_name = ?, discord_handle = ? WHERE id = 1').run(evil, evil);
  for (const res of [await ask(env, RAVI), await call(env, '/api/bot/campaigns')]) {
    const out = await res.json();
    const text = out.lines ? out.lines.join(' ') : JSON.stringify(out.campaigns);
    assert.equal(/@(everyone|here)/.test(text), false, 'nothing can read as a channel-wide mention');
    assert.equal(/<@[!&]?\d/.test(text), false, 'nor as a user or role mention');
    assert.equal(text.includes('](http'), false, 'nor as a working link: the closing bracket is escaped');
  }
});

/* ----------------------------------------------------------------- campaigns */

test('the campaign list is the public shape: name, rate, minimum, platforms, nothing else', async () => {
  const env = world();
  const out = await (await call(env, '/api/bot/campaigns')).json();
  assert.equal(out.campaigns.length, 2, 'only active campaigns');
  assert.deepEqual(Object.keys(out.campaigns[0]).sort(), ['cpm', 'id', 'min_views', 'name', 'platforms']);
  assert.deepEqual(out.campaigns[0].platforms, ['instagram', 'youtube']);
  assert.deepEqual(out.campaigns.map(c => c.name), ['Reel Rush', 'Mali Music'], 'newest first');
});

test('with no campaigns the list is empty, not an error', async () => {
  const env = world();
  env.DB._sqlite.prepare("UPDATE campaigns SET status = 'completed'").run();
  const res = await call(env, '/api/bot/campaigns');
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).campaigns, []);
});

/* ----------------------------------------------------------------- the breaker */

test('normal use never trips the breaker', async () => {
  const env = world();
  for (let i = 0; i < 40; i++) assert.equal((await ask(env, String(100000000000000000n + BigInt(i)))).status, 200);
});

test('walking through many different people is stopped, and the admin is told once', async () => {
  const env = world();
  const at = Date.now();
  const ins = env.DB._sqlite.prepare('INSERT INTO bot_api_calls (ts, subject_hash) VALUES (?, ?)');
  for (let i = 0; i < BOT_LIMITS.maxDistinct; i++) ins.run(at - 1000, `subject-${i}`);
  const a = await ask(env, '300000000000000001');
  assert.equal(a.status, 429);
  assert.equal((await a.json()).error, 'rate_limited');
  assert.equal((await ask(env, '300000000000000002')).status, 429, 'and it stays refused while the window is full');
  const logged = env.DB._sqlite.prepare("SELECT * FROM error_log WHERE source = 'bot_api'").all();
  assert.equal(logged.length, 1, 'one alert, not one per refused call');
  assert.equal(logged[0].code, 'VOLUME');
  assert.match(logged[0].detail, /BOT_API_TOKEN/);
});

test('sheer volume is stopped too, even about one person', async () => {
  const env = world();
  const at = Date.now();
  const ins = env.DB._sqlite.prepare('INSERT INTO bot_api_calls (ts, subject_hash) VALUES (?, ?)');
  for (let i = 0; i < BOT_LIMITS.maxCalls; i++) ins.run(at - 1000, 'same');
  assert.equal((await ask(env, RAVI)).status, 429);
});

test('the breaker clears by itself as the window slides', async () => {
  const env = world();
  const old = Date.now() - BOT_LIMITS.windowMs - 60000;
  const ins = env.DB._sqlite.prepare('INSERT INTO bot_api_calls (ts, subject_hash) VALUES (?, ?)');
  for (let i = 0; i < BOT_LIMITS.maxDistinct + 50; i++) ins.run(old, `subject-${i}`);
  assert.equal((await ask(env, RAVI)).status, 200, 'old calls no longer count');
});

test('the log holds no Discord ids, and old rows are pruned', async () => {
  const env = world();
  env.DB._sqlite.prepare('INSERT INTO bot_api_calls (ts, subject_hash) VALUES (?, ?)').run(Date.now() - 3 * 24 * 60 * 60 * 1000, 'ancient');
  await ask(env, RAVI);
  const rows = env.DB._sqlite.prepare('SELECT * FROM bot_api_calls').all();
  assert.equal(JSON.stringify(rows).includes(RAVI), false);
  assert.equal(rows.some(r => r.subject_hash === 'ancient'), false);
  assert.match(rows[0].subject_hash, /^[0-9a-f]{32}$/);
});

/* ------------------------------------------------------ when things break */

test('a database failure under the bot API is a JSON 500 the bot can read, and is logged', async () => {
  const env = world();
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    if (/FROM clippers WHERE discord_user_id/.test(sql)) throw new Error('D1_ERROR: simulated outage');
    return realPrepare(sql);
  };
  const r = req('/api/bot/answer', { method: 'POST', body: { discord_user_id: RAVI, intent: 'status' } });
  const res = await worker.fetch(r, env, { waitUntil() {} });
  assert.equal(res.status, 500);
  assert.match(res.headers.get('Content-Type'), /application\/json/, 'JSON, never an HTML error page');
  assert.equal(typeof (await res.json()).error, 'string');
  env.DB.prepare = realPrepare;
  const logged = env.DB._sqlite.prepare("SELECT message FROM error_log WHERE source = 'api'").all();
  assert.equal(logged.length, 1);
  assert.match(logged[0].message, /simulated outage/);
});
