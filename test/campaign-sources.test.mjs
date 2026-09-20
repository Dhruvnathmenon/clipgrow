// Reference videos (public Drive links only) and raw footage sources (a Drive
// link, or the official pages on social platforms).
//
// Two things matter. First that only real Drive and platform links get in --
// these render as clickable cards to clippers under ClipGrow's name, so a
// spoofed host is a phishing link. Second that raw footage never leaks: it is
// working material for people who joined, not public content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { handleClipper } from '../src/routes/clipper.js';
import { handleAdmin } from '../src/routes/admin.js';
import { createSessionCookie } from '../src/auth.js';
import {
  driveLink, sourceLink, normaliseReferenceLinks, normaliseRawSources,
  MAX_REFERENCE_LINKS, readStored
} from '../src/campaign-sources.js';

const DRIVE_FILE = 'https://drive.google.com/file/d/1AbC/view?usp=sharing';
const DRIVE_FOLDER = 'https://drive.google.com/drive/folders/1XyZ';

test('a Drive link must be a Drive file or folder, nothing else', () => {
  assert.ok(driveLink(DRIVE_FILE).url);
  assert.ok(driveLink(DRIVE_FOLDER).url);
  assert.ok(driveLink('https://drive.google.com/open?id=1AbC').url, 'the older ?id= form');

  for (const bad of [
    'https://youtube.com/watch?v=abc',       // reference is Drive only
    'https://www.instagram.com/p/abc',
    'http://drive.google.com/file/d/1/view', // not https
    'https://drive.google.com/',             // the site root is not a file
    'https://docs.google.com/document/d/1/edit',
    'not a link',
    ''
  ]) assert.ok(driveLink(bad).error, `should refuse: ${bad}`);
});

test('a reference video can be a Drive file or an already-posted video on a listed platform', () => {
  const r = normaliseReferenceLinks([DRIVE_FILE, 'https://www.instagram.com/reel/abc123/', 'https://youtu.be/xyz', 'https://www.tiktok.com/@a/video/1']);
  assert.equal(r.error, undefined);
  assert.equal(r.value.length, 4);
  // Same allowlist as raw footage: an arbitrary site is still refused.
  assert.match(normaliseReferenceLinks(['https://randomsite.com/v']).error, /Reference video/);
  assert.ok(normaliseReferenceLinks(['https://instagram.com.evil.com/reel/1']).error, 'a look-alike host still cannot pass');
});

test('a look-alike host cannot pass as Drive or as a social platform', () => {
  for (const spoof of [
    'https://drive.google.com.evil.com/file/d/1/view',
    'https://evil.com/?u=drive.google.com/file/d/1/view',
    'https://drive.google.com@evil.com/file/d/1/view',
    'https://evildrive.google.com/file/d/1/view',
    'https://notinstagram.com/p/abc',
    'https://instagram.com.evil.com/p/abc',
    'https://evil.com/instagram.com'
  ]) {
    assert.ok(driveLink(spoof).error && sourceLink(spoof).error, `should refuse: ${spoof}`);
  }
});

test('raw footage takes a Drive link or any listed platform, and reports which', () => {
  assert.equal(sourceLink(DRIVE_FOLDER).kind, 'drive');
  assert.equal(sourceLink('https://www.instagram.com/officialpage/reels/').kind, 'instagram');
  assert.equal(sourceLink('https://youtu.be/abc123').kind, 'youtube');
  assert.equal(sourceLink('https://www.youtube.com/@channel/shorts').kind, 'youtube');
  assert.equal(sourceLink('https://www.tiktok.com/@page').kind, 'tiktok');
  assert.equal(sourceLink('https://x.com/page').kind, 'x');
  assert.equal(sourceLink('https://twitter.com/page').kind, 'x');
  assert.ok(sourceLink('https://randomsite.com/video').error, 'an unlisted site is refused, with a message saying what is allowed');
  assert.match(sourceLink('https://randomsite.com/video').error, /Drive/);
});

test('several links can be pasted at once, one per line, and duplicates collapse', () => {
  const r = normaliseRawSources(`${DRIVE_FOLDER}\nhttps://www.instagram.com/official/\n\n${DRIVE_FOLDER}\n`);
  assert.equal(r.value.length, 2);
  assert.deepEqual(r.value.map(x => x.kind), ['drive', 'instagram']);
});

test('a label survives, stripped of control characters and capped', () => {
  const r = normaliseRawSources([{ url: DRIVE_FOLDER, label: 'Main\nfootage ' + 'x'.repeat(200) }]);
  assert.equal(/[\n\r]/.test(r.value[0].label), false);
  assert.ok(r.value[0].label.length <= 60);
});

test('one bad link rejects the list and names the problem', () => {
  const r = normaliseReferenceLinks([DRIVE_FILE, 'https://evil.com/x']);
  assert.match(r.error, /Reference video/);
  const raw = normaliseRawSources([DRIVE_FILE, 'https://evil.com/x']);
  assert.match(raw.error, /Raw footage/);
});

test('there is a ceiling on how many links a campaign carries', () => {
  const many = Array.from({ length: MAX_REFERENCE_LINKS + 1 }, (_, i) => `https://drive.google.com/file/d/id${i}/view`);
  assert.match(normaliseReferenceLinks(many).error, /At most/);
});

test('stored values read back safely even when malformed or missing', () => {
  assert.deepEqual(readStored({}), { reference_links: [], raw_sources: [] });
  assert.deepEqual(readStored({ reference_links: '{oops', raw_sources: '"str"' }), { reference_links: [], raw_sources: [] });
});

/* ------------------------------------------------------------- the routes */

const NOW = Date.now();
const SECRET = 'test-secret';

function world() {
  const db = makeSqliteD1({
    clippers: [1, 2, 3].map(id => ({ id, username: `c${id}`, password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW })),
    campaigns: [{ id: 1, name: 'C', description: '', cpm: 40, budget: 100000, status: 'active', created_at: NOW,
                  model: 'cpm', min_views: 0, allowed_platforms: 'instagram',
                  reference_links: JSON.stringify([DRIVE_FILE]),
                  raw_sources: JSON.stringify([{ url: DRIVE_FOLDER, kind: 'drive', label: 'Raw' }]) }],
    participations: [
      { id: 1, clipper_id: 1, campaign_id: 1, status: 'active', joined_at: NOW },
      { id: 3, clipper_id: 3, campaign_id: 1, status: 'kicked', joined_at: NOW }
    ]
  });
  return { DB: db, SESSION_SECRET: SECRET, ADMIN_PASSWORD: 'admin-pass' };
}

async function clipperList(env, id) {
  const cookie = await createSessionCookie('clipper', id, SECRET);
  const req = new Request('https://clipgrow.in/api/clipper/campaigns', { headers: { Cookie: cookie.split(';')[0] } });
  return (await (await handleClipper(req, env, new URL(req.url))).json()).campaigns[0];
}

test('raw footage reaches only a clipper who joined and was not removed', async () => {
  const env = world();
  const joined = await clipperList(env, 1);
  assert.equal(joined.raw_sources.length, 1, 'a joined clipper sees the raw footage');
  assert.equal(joined.reference_links.length, 1);

  const stranger = await clipperList(env, 2);
  assert.deepEqual(stranger.raw_sources, [], 'someone who never joined does not');
  assert.equal(stranger.reference_links.length, 1, 'but can see the reference video while deciding to join');

  const removed = await clipperList(env, 3);
  assert.deepEqual(removed.raw_sources, [], 'and a removed clipper loses access to it');
});

async function adminCall(env, path, method, body) {
  const cookie = await createSessionCookie('admin', 0, SECRET);
  const req = new Request(`https://clipgrow.in${path}`, {
    method, headers: { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return handleAdmin(req, env, new URL(req.url));
}
const base = { name: 'New', cpm: 40, budget: 1000 };

test('with the gate off a campaign can still be created without sources', async () => {
  const env = world();
  assert.equal((await adminCall(env, '/api/admin/campaigns', 'POST', base)).status, 201);
});

test('with the gate on, a new campaign needs a reference video and a raw footage source', async () => {
  const env = world();
  env.DB._sqlite.exec("UPDATE feature_flags SET enabled = 1");

  let res = await adminCall(env, '/api/admin/campaigns', 'POST', base);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /reference video/i);

  res = await adminCall(env, '/api/admin/campaigns', 'POST', { ...base, reference_links: [DRIVE_FILE] });
  assert.match((await res.json()).error, /raw footage/i);

  res = await adminCall(env, '/api/admin/campaigns', 'POST', {
    ...base, reference_links: [DRIVE_FILE], raw_sources: [DRIVE_FOLDER, 'https://www.instagram.com/official/']
  });
  assert.equal(res.status, 201);
  const row = env.DB._sqlite.prepare('SELECT raw_sources FROM campaigns ORDER BY id DESC LIMIT 1').get();
  assert.equal(JSON.parse(row.raw_sources).length, 2);
});

test('a bad link is refused on create and on edit, and an edit leaves untouched fields alone', async () => {
  const env = world();
  let res = await adminCall(env, '/api/admin/campaigns', 'POST', { ...base, reference_links: ['https://evil.com/watch?v=1'] });
  assert.equal(res.status, 400);

  res = await adminCall(env, '/api/admin/campaigns/1', 'PATCH', { raw_sources: ['https://evil.com/x'] });
  assert.equal(res.status, 400);
  const still = env.DB._sqlite.prepare('SELECT raw_sources FROM campaigns WHERE id = 1').get();
  assert.equal(JSON.parse(still.raw_sources)[0].url, DRIVE_FOLDER, 'a refused edit changed nothing');

  // Editing only the name must not blank the links.
  res = await adminCall(env, '/api/admin/campaigns/1', 'PATCH', { name: 'Renamed' });
  assert.equal(res.status, 200);
  const after = env.DB._sqlite.prepare('SELECT reference_links, raw_sources FROM campaigns WHERE id = 1').get();
  assert.equal(JSON.parse(after.reference_links).length, 1);
  assert.equal(JSON.parse(after.raw_sources).length, 1);

  // An explicit empty list does clear it.
  res = await adminCall(env, '/api/admin/campaigns/1', 'PATCH', { raw_sources: [] });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(env.DB._sqlite.prepare('SELECT raw_sources FROM campaigns WHERE id = 1').get().raw_sources).length, 0);
});
