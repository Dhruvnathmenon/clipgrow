// Step 1 of the two-step campaign onboarding: a clipper submits a video, a
// moderator approves or rejects it with a written reason, three rejections
// remove them from that campaign, and only an approval unlocks step 2
// (connecting the social account).
//
// The gate is the whole point. Before this existed, joining a campaign was a
// single unconditional INSERT and connecting an account needed nothing but
// that participation -- so these tests care most about the two ends: that an
// unapproved clipper genuinely cannot reach the connect step, and that an
// approved one genuinely can.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleClipper } from '../src/routes/clipper.js';
import { handleModerator } from '../src/routes/moderator.js';
import { createSessionCookie } from '../src/auth.js';
import { MAX_ATTEMPTS } from '../src/applications.js';

const NOW = Date.now();
const SESSION_SECRET = 'test-secret';

function seedEnv() {
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'clipper1', password_hash: 'h', password_salt: 's',
                 status: 'active', created_at: NOW }],
    moderators: [{ id: 7, username: 'mod1', password_hash: 'h', password_salt: 's',
                   display_name: 'Mod One', status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'Test Campaign', description: '', cpm: 40, budget: 100000,
                  status: 'active', created_at: NOW, model: 'cpm', min_views: 1000,
                  allowed_platforms: 'instagram' }],
    participations: [{ id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW }]
  });
  return { DB: db, SESSION_SECRET, ADMIN_PASSWORD: 'admin-pass' };
}

async function asClipper(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('clipper', 1, env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method, headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleClipper(request, env, new URL(request.url));
}

async function asModerator(env, path, { method = 'GET', body } = {}) {
  const cookie = await createSessionCookie('moderator', 7, env.SESSION_SECRET);
  const request = new Request(`https://clipgrow.in${path}`, {
    method, headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return handleModerator(request, env, new URL(request.url));
}

const submit = (env, url = 'https://drive.google.com/file/demo') =>
  asClipper(env, '/api/clipper/campaigns/1/applications', { method: 'POST', body: { video_url: url } });

const connect = (env) =>
  asClipper(env, '/api/clipper/access-request', {
    method: 'POST', body: { campaign_id: 1, platform: 'instagram', identifier: 'my.handle' }
  });

async function reviewLatest(env, verdict, note = 'Looks good.') {
  const q = await (await asModerator(env, '/api/moderator/applications')).json();
  const id = q.applications[0].id;
  return asModerator(env, `/api/moderator/applications/${id}`, { method: 'POST', body: { verdict, note } });
}

test('connecting an account is refused until a video has been approved', async () => {
  const env = seedEnv();

  // The gate, before anything has been submitted at all.
  let res = await connect(env);
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /submit your video/i);

  // Still refused while a reviewer has it -- a pending application is not a pass.
  assert.equal((await submit(env)).status, 201);
  res = await connect(env);
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /still with a reviewer/i);

  // And allowed the moment it is approved.
  assert.equal((await reviewLatest(env, 'approved')).status, 200);
  res = await connect(env);
  assert.equal(res.status, 201, 'an approved clipper reaches the existing tester_requests flow');
  const row = await env.DB.prepare('SELECT status FROM tester_requests WHERE clipper_id = 1').first();
  assert.equal(row.status, 'requested', 'step 2 begins exactly as it did before -- awaiting the admin');
});

test('only one application can be in flight at a time', async () => {
  const env = seedEnv();
  assert.equal((await submit(env)).status, 201);
  const res = await submit(env);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /already with a reviewer/i);
  assert.equal(env.DB._rows('campaign_applications').length, 1, 'no second attempt was recorded');
});

test('a rejection costs one attempt and lets the clipper try again', async () => {
  const env = seedEnv();
  await submit(env);
  const r = await (await reviewLatest(env, 'rejected', 'Captions are out of sync.')).json();
  assert.equal(r.removed_from_campaign, false, 'one rejection is not a removal');

  const state = await (await asClipper(env, '/api/clipper/campaigns/1/applications')).json();
  assert.equal(state.state, 'rejected');
  assert.equal(state.attempts_left, MAX_ATTEMPTS - 1);
  assert.equal(state.may_submit, true, 'they can send a revised video');
  assert.equal(state.may_connect, false, 'but still cannot skip ahead to connecting');
  assert.equal(state.history[0].reviewer_note, 'Captions are out of sync.',
    'the reason reaches the clipper -- that is what makes the next attempt usable');
});

test(`${MAX_ATTEMPTS} rejections removes the clipper from that campaign`, async () => {
  const env = seedEnv();
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    assert.equal((await submit(env)).status, 201, `attempt ${i} accepted`);
    const r = await (await reviewLatest(env, 'rejected', `Not there yet (${i}).`)).json();
    assert.equal(r.removed_from_campaign, i === MAX_ATTEMPTS,
      `removal happens on attempt ${MAX_ATTEMPTS}, not before`);
  }

  const part = await env.DB.prepare('SELECT status, status_note FROM participations WHERE id = 1').first();
  assert.equal(part.status, 'kicked', 'reuses the existing kicked status, so every screen already understands it');
  assert.match(part.status_note, /3 rejected verification videos/i, 'and says why, for the admin who may reverse it');

  const res = await submit(env);
  assert.equal(res.status, 403, 'a fourth attempt is refused');
  const state = await (await asClipper(env, '/api/clipper/campaigns/1/applications')).json();
  assert.equal(state.state, 'exhausted');
  assert.equal(state.may_submit, false);
  assert.equal(state.may_connect, false);
});

test('a verdict without a reason is refused, on approval as well as rejection', async () => {
  const env = seedEnv();
  await submit(env);
  for (const verdict of ['approved', 'rejected']) {
    const res = await reviewLatest(env, verdict, '   ');
    assert.equal(res.status, 400, `${verdict} still needs a note`);
    assert.match((await res.json()).error, /note explaining/i);
  }
  const row = await env.DB.prepare('SELECT status FROM campaign_applications WHERE id = 1').first();
  assert.equal(row.status, 'pending', 'the application is untouched by a refused verdict');
});

test('an application cannot be reviewed twice', async () => {
  const env = seedEnv();
  await submit(env);
  assert.equal((await reviewLatest(env, 'approved')).status, 200);

  // reviewLatest reads the queue, which is now empty -- go at the row directly,
  // the way a stale browser tab with the old id would.
  const res = await asModerator(env, '/api/moderator/applications/1',
    { method: 'POST', body: { verdict: 'rejected', note: 'Changed my mind.' } });
  assert.equal(res.status, 409);
  const row = await env.DB.prepare('SELECT status, reviewer_note FROM campaign_applications WHERE id = 1').first();
  assert.equal(row.status, 'approved', 'the first verdict stands');
});

test('the queue tells a reviewer when their verdict is the one that removes someone', async () => {
  const env = seedEnv();
  await submit(env);
  await reviewLatest(env, 'rejected', 'First pass.');
  await submit(env);
  await reviewLatest(env, 'rejected', 'Second pass.');
  await submit(env);

  const q = await (await asModerator(env, '/api/moderator/applications')).json();
  assert.equal(q.applications.length, 1);
  assert.equal(q.applications[0].attempt, MAX_ATTEMPTS);
  assert.equal(q.applications[0].is_final_attempt, true,
    'the reviewer sees this is the last attempt before they decide');
  assert.equal(q.applications[0].prior_rejections, MAX_ATTEMPTS - 1);
});

test('a clipper cannot apply to a campaign they never joined', async () => {
  const env = seedEnv();
  await env.DB.prepare('DELETE FROM participations WHERE id = 1').run();
  const res = await submit(env);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /join this campaign/i);
});
