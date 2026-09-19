// Drive-backed video submission.
//
// Every Google call goes through an injected fetch, so these run the real
// logic against scripted responses -- no credentials, no network. What
// matters most here is the trust boundary: the browser tells us which file
// id it uploaded, and the browser is not a source we can trust.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  driveFileName, driveConfigured, createUploadSession, verifyUploadedFile,
  deleteFile, moveToRejected, getAccessToken, DriveError,
  MAX_UPLOAD_BYTES, DRIVE_REJECTED_RETENTION_MS
} from '../src/drive.js';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { purgeExpiredRejections } from '../src/applications.js';

const ENV = {
  GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_REFRESH_TOKEN: 'refresh', GDRIVE_PENDING_FOLDER_ID: 'PENDING',
  GDRIVE_REJECTED_FOLDER_ID: 'REJECTED'
};

const ok = (body, headers = {}) => ({
  ok: true, status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
  headers: { get: k => headers[k] || headers[k.toLowerCase()] || null }
});
const bad = (status, body = 'nope') => ({
  ok: false, status, json: async () => ({}), text: async () => body,
  headers: { get: () => null }
});

/** Scripts responses in order, recording every request for assertions. */
function scriptedFetch(responses) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch: ' + url);
    return next;
  };
  impl.calls = calls;
  return impl;
}

const TOKEN_OK = () => ok({ access_token: 'at-123', expires_in: 3599 });

test('driveConfigured only passes when every secret is present', () => {
  assert.equal(driveConfigured(ENV), true);
  assert.equal(driveConfigured({}), false);
  assert.equal(driveConfigured({ ...ENV, GOOGLE_REFRESH_TOKEN: undefined }), false,
    'a missing refresh token means uploads cannot work, so the route must refuse rather than half-try');
});

test('file names identify the submission and survive hostile input', () => {
  const name = driveFileName({
    clipperUsername: 'Arjun K', campaignName: 'Mali — Music Campaign',
    attempt: 2, at: new Date('2026-09-19T10:00:00Z')
  });
  assert.equal(name, 'arjun-k__mali-music-campaign__a2__2026-09-19.mp4');

  // A name reaches logs, URLs and the founder's own file browser, so
  // separators and control characters must not survive.
  const nasty = driveFileName({
    clipperUsername: '../../etc/passwd', campaignName: 'a\nb/c',
    attempt: 1, at: new Date('2026-09-19T10:00:00Z'), ext: 'mov'
  });
  assert.equal(/[/\\\n\r]/.test(nasty), false, 'no path or newline characters survive');
  assert.match(nasty, /^etc-passwd__a-b-c__a1__2026-09-19\.mov$/);

  // An extension is only honoured if it looks like one.
  assert.match(driveFileName({ clipperUsername: 'x', campaignName: 'y', attempt: 1, ext: 'exe; rm -rf' }), /\.mp4$/);
});

test('an upload session is refused before the bytes are sent, not after', async () => {
  // Too big: caught locally, so the clipper is not told to wait through a
  // 500MB upload only to be rejected at the end.
  await assert.rejects(
    () => createUploadSession(ENV, { fileName: 'a.mp4', mimeType: 'video/mp4', sizeBytes: MAX_UPLOAD_BYTES + 1 },
      { fetchImpl: scriptedFetch([]) }),
    e => e instanceof DriveError && e.code === 'DRIVE_TOO_LARGE' && e.status === 400);

  await assert.rejects(
    () => createUploadSession(ENV, { fileName: 'a.exe', mimeType: 'application/x-msdownload', sizeBytes: 100 },
      { fetchImpl: scriptedFetch([]) }),
    e => e instanceof DriveError && e.code === 'DRIVE_BAD_TYPE');
});

test('a valid session hands back Google\'s upload URL and targets the pending folder', async () => {
  const f = scriptedFetch([TOKEN_OK(), ok({}, { Location: 'https://upload.google/session/abc' })]);
  const r = await createUploadSession(ENV, {
    fileName: 'x.mp4', mimeType: 'video/mp4', sizeBytes: 1024, origin: 'https://clipgrow.in'
  }, { fetchImpl: f });

  assert.equal(r.sessionUrl, 'https://upload.google/session/abc');
  const init = f.calls[1];
  assert.match(init.url, /uploadType=resumable/);
  assert.equal(JSON.parse(init.body).parents[0], 'PENDING', 'lands in the pending folder, which the trust check relies on');
  assert.equal(init.headers.Origin, 'https://clipgrow.in',
    'origin is forwarded or Google omits the CORS headers the browser upload needs');
  assert.equal(init.headers['X-Upload-Content-Length'], '1024');
});

test('a revoked refresh token is reported as something a human must fix', async () => {
  const f = scriptedFetch([bad(400, 'invalid_grant')]);
  await assert.rejects(() => getAccessToken(ENV, { fetchImpl: f }),
    e => e instanceof DriveError && e.code === 'DRIVE_AUTH' && /re-authorise/i.test(e.fix));
});

/* The security boundary. The browser reports the id Google gave it, so
   without re-reading the object server-side a clipper could submit any file
   id in the account -- including another clipper's -- and have it attached
   to their own application. Checking the parent folder is what makes that
   impossible rather than merely unlikely. */
test('a file outside the pending folder is refused, however real its id is', async () => {
  const f = scriptedFetch([TOKEN_OK(), ok({ id: 'f1', name: 'someone-else.mp4', size: '10', parents: ['SOMEONE_ELSES_FOLDER'] })]);
  await assert.rejects(() => verifyUploadedFile(ENV, 'f1', { fetchImpl: f }),
    e => e instanceof DriveError && e.code === 'DRIVE_WRONG_PARENT' && e.status === 400);
});

test('a trashed or missing upload is refused', async () => {
  await assert.rejects(
    () => verifyUploadedFile(ENV, 'f1', { fetchImpl: scriptedFetch([TOKEN_OK(), ok({ id: 'f1', trashed: true, parents: ['PENDING'] })]) }),
    e => e.code === 'DRIVE_TRASHED');
  await assert.rejects(
    () => verifyUploadedFile(ENV, 'gone', { fetchImpl: scriptedFetch([TOKEN_OK(), bad(404)]) }),
    e => e.code === 'DRIVE_NOT_FOUND');
});

test('a genuine upload in the pending folder is accepted, with its real size', async () => {
  const f = scriptedFetch([TOKEN_OK(), ok({ id: 'f1', name: 'x.mp4', size: '2048', mimeType: 'video/mp4', parents: ['PENDING'] })]);
  const file = await verifyUploadedFile(ENV, 'f1', { fetchImpl: f });
  assert.deepEqual(file, { id: 'f1', name: 'x.mp4', size: 2048, mimeType: 'video/mp4' });
});

test('deleting an already-deleted file is a success, not an error', async () => {
  // The desired end state is "gone", and it is gone.
  assert.equal(await deleteFile(ENV, 'f1', { fetchImpl: scriptedFetch([TOKEN_OK(), bad(404)]) }), true);
  await assert.rejects(() => deleteFile(ENV, 'f1', { fetchImpl: scriptedFetch([TOKEN_OK(), bad(500)]) }),
    e => e.code === 'DRIVE_DELETE');
});

test('rejecting moves the file between folders rather than destroying it', async () => {
  const f = scriptedFetch([TOKEN_OK(), ok({ id: 'f1', parents: ['REJECTED'] })]);
  await moveToRejected(ENV, 'f1', { fetchImpl: f });
  const patch = f.calls[1];
  assert.equal(patch.method, 'PATCH');
  assert.match(patch.url, /addParents=REJECTED/);
  assert.match(patch.url, /removeParents=PENDING/);
});

test('with no rejected folder configured the file is deleted instead of stranded', async () => {
  // Otherwise a missing setting would quietly pile files up in the pending
  // folder, where nothing would ever collect them.
  const env = { ...ENV, GDRIVE_REJECTED_FOLDER_ID: undefined };
  const f = scriptedFetch([TOKEN_OK(), ok({})]);
  await moveToRejected(env, 'f1', { fetchImpl: f });
  assert.equal(f.calls[1].method, 'DELETE');
});

test('the purge sweep only takes rejected videos past their retention', async () => {
  const NOW = Date.now();
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'c1', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'C', description: '', cpm: 40, budget: 1000, status: 'active',
                  created_at: NOW, model: 'cpm', min_views: 0, allowed_platforms: 'instagram' }],
    campaign_applications: [
      { id: 1, clipper_id: 1, campaign_id: 1, attempt: 1, status: 'rejected', drive_file_id: 'old',
        reviewed_at: NOW - DRIVE_REJECTED_RETENTION_MS - 1000, created_at: NOW },
      { id: 2, clipper_id: 1, campaign_id: 1, attempt: 2, status: 'rejected', drive_file_id: 'fresh',
        reviewed_at: NOW - 1000, created_at: NOW },
      { id: 3, clipper_id: 1, campaign_id: 1, attempt: 3, status: 'pending', drive_file_id: 'inflight',
        created_at: NOW }
    ]
  });

  const deleted = [];
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes('oauth2')) return TOKEN_OK();
    deleted.push(decodeURIComponent(String(url)));
    return ok({});
  };
  const r = await purgeExpiredRejections(db, ENV, { at: NOW, fetchImpl });

  assert.equal(r.purged, 1);
  assert.equal(r.failed, 0);
  assert.equal(deleted.length, 1, 'exactly one file was deleted');
  assert.match(deleted[0], /files\/old/, 'and it was the expired one');

  const rows = db._rows('campaign_applications');
  assert.equal(rows.find(x => x.id === 1).drive_file_id, null, 'the purged row no longer claims to have a file');
  assert.equal(rows.find(x => x.id === 2).drive_file_id, 'fresh', 'a rejection inside its week is untouched');
  assert.equal(rows.find(x => x.id === 3).drive_file_id, 'inflight', 'a pending application is never swept');
});

/* A failed delete must leave the row alone, so the next sweep retries it.
   Clearing the id on failure would orphan the file in the founder's Drive
   with nothing left pointing at it. */
test('a Drive failure during purge leaves the row for the next sweep', async () => {
  const NOW = Date.now();
  const db = makeSqliteD1({
    clippers: [{ id: 1, username: 'c1', password_hash: 'h', password_salt: 's', status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'C', description: '', cpm: 40, budget: 1000, status: 'active',
                  created_at: NOW, model: 'cpm', min_views: 0, allowed_platforms: 'instagram' }],
    campaign_applications: [
      { id: 1, clipper_id: 1, campaign_id: 1, attempt: 1, status: 'rejected', drive_file_id: 'old',
        reviewed_at: NOW - DRIVE_REJECTED_RETENTION_MS - 1000, created_at: NOW }
    ]
  });
  const fetchImpl = async (url) => String(url).includes('oauth2') ? TOKEN_OK() : bad(500);
  const r = await purgeExpiredRejections(db, ENV, { at: NOW, fetchImpl });

  assert.equal(r.purged, 0);
  assert.equal(r.failed, 1);
  assert.equal(db._rows('campaign_applications')[0].drive_file_id, 'old',
    'the id survives, so the file is still findable on the next pass');
});
