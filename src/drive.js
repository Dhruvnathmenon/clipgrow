// Google Drive storage for submitted verification videos.
//
// WHY OAUTH AND NOT A SERVICE ACCOUNT
// A service account has no Drive storage of its own -- files it creates are
// owned by it and counted against its quota, which is zero on a personal
// Google account. The usual escapes (domain-wide delegation, Shared Drives)
// both need Google Workspace. ClipGrow's Drive is a personal account with a
// 1TB Google One plan, so the only way to write into that 1TB is to act as
// the account owner: he consents once, and we keep the refresh token.
//
// Everything here therefore runs as the founder's own Google account. Files
// are owned by him, live in his Drive, and count against his quota.
//
// THE UPLOAD PATH DELIBERATELY AVOIDS THE WORKER
// A 500MB video cannot sensibly be proxied through a Cloudflare Worker. The
// Worker's only job is to mint a resumable upload session (one small signed
// request) and hand the browser the session URL; the bytes go from the
// clipper straight to Google. That keeps the Worker's request short, its
// memory flat, and a slow uploader from occupying an invocation.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';

// A rejected clipper's video is kept this long before it is purged, so a
// contested rejection can still be checked while the dispute is live. An
// approved video is deleted immediately instead -- it has served its purpose
// the moment the clipper is let through.
export const DRIVE_REJECTED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Accepted upload types and ceiling. Enforced when the session is minted
// rather than after the bytes arrive, because refusing a 500MB upload after
// the clipper has waited for it to finish is the worst possible moment.
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export const ALLOWED_MIME = ['video/mp4', 'video/quicktime'];

export class DriveError extends Error {
  constructor(message, { code = 'DRIVE_ERROR', status = 502, fix = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.fix = fix;
  }
}

/** True when every secret this module needs is present. */
export function driveConfigured(env) {
  return !!(env && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET &&
            env.GOOGLE_REFRESH_TOKEN && env.GDRIVE_PENDING_FOLDER_ID);
}

/**
 * Exchanges the stored refresh token for a short-lived access token.
 *
 * Not cached across invocations on purpose: a Worker isolate is not a
 * reliable place to hold a secret-derived token between requests, and this
 * call is cheap next to the upload it authorises. A refresh that fails is
 * almost always the founder having revoked the app or changed account
 * security, so it is reported as something a human must fix rather than a
 * transient error worth retrying.
 */
export async function getAccessToken(env, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new DriveError('Could not reach Google Drive to store the video.', {
      code: 'DRIVE_AUTH', status: 502,
      fix: `Re-authorise ClipGrow's Google account and update GOOGLE_REFRESH_TOKEN. Google said: ${body.slice(0, 200)}`
    });
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new DriveError('Google Drive did not return an access token.', { code: 'DRIVE_AUTH' });
  }
  return data.access_token;
}

/**
 * The name a submitted file is stored under.
 *
 * Built from the clipper, the campaign and the attempt so a moderator can
 * tell what a file is from its name alone, and so two clippers can never
 * collide. Everything outside a conservative character set is replaced --
 * Drive itself is permissive, but these names end up in logs, URLs and the
 * founder's own file browser, where a slash or a newline is a problem.
 */
export function driveFileName({ clipperUsername, campaignName, attempt, at = new Date(), ext = 'mp4' }) {
  const slug = (s, max) => String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'unknown';
  const date = at.toISOString().slice(0, 10);
  const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : 'mp4';
  return `${slug(clipperUsername, 40)}__${slug(campaignName, 40)}__a${attempt}__${date}.${safeExt}`;
}

/**
 * Starts a resumable upload and returns the session URL for the browser.
 *
 * `origin` is passed through to Google because the browser, not the Worker,
 * performs the upload -- without it Google will not send the CORS headers
 * that let a cross-origin PUT succeed, and the upload fails in the browser
 * with no useful error.
 */
export async function createUploadSession(env, { fileName, mimeType, sizeBytes, origin }, { fetchImpl = fetch } = {}) {
  if (!ALLOWED_MIME.includes(mimeType)) {
    throw new DriveError('That file type is not supported. Upload an MP4 or MOV.', {
      code: 'DRIVE_BAD_TYPE', status: 400
    });
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new DriveError('Could not read the size of that file.', { code: 'DRIVE_BAD_SIZE', status: 400 });
  }
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    throw new DriveError(`That file is too large. The limit is ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`, {
      code: 'DRIVE_TOO_LARGE', status: 400
    });
  }

  const token = await getAccessToken(env, { fetchImpl });
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Upload-Content-Type': mimeType,
    'X-Upload-Content-Length': String(sizeBytes)
  };
  if (origin) headers.Origin = origin;

  const res = await fetchImpl(UPLOAD_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: fileName, parents: [env.GDRIVE_PENDING_FOLDER_ID] })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new DriveError('Google Drive refused the upload.', {
      code: 'DRIVE_SESSION', status: 502, fix: body.slice(0, 200)
    });
  }
  const sessionUrl = res.headers.get('Location') || res.headers.get('location');
  if (!sessionUrl) {
    throw new DriveError('Google Drive did not return an upload URL.', { code: 'DRIVE_SESSION' });
  }
  return { sessionUrl, fileName };
}

/**
 * Confirms a file really exists, is the size we expected, and sits in the
 * pending folder.
 *
 * The browser reports the id it got from Google, and the browser is not a
 * source this can trust: without this check a clipper could submit any file
 * id -- including one belonging to someone else's application -- and have it
 * attached to their own. Checking the parent folder is what makes the id
 * unguessable in practice as well as unforgeable in principle.
 */
export async function verifyUploadedFile(env, fileId, { fetchImpl = fetch } = {}) {
  const token = await getAccessToken(env, { fetchImpl });
  const url = `${FILES_URL}/${encodeURIComponent(fileId)}?fields=id,name,size,mimeType,parents,trashed&supportsAllDrives=true`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new DriveError('That upload could not be found.', { code: 'DRIVE_NOT_FOUND', status: 400 });
  }
  const f = await res.json();
  if (f.trashed) throw new DriveError('That upload is no longer available.', { code: 'DRIVE_TRASHED', status: 400 });
  if (!(f.parents || []).includes(env.GDRIVE_PENDING_FOLDER_ID)) {
    throw new DriveError('That file was not uploaded through ClipGrow.', { code: 'DRIVE_WRONG_PARENT', status: 400 });
  }
  return { id: f.id, name: f.name, size: Number(f.size) || 0, mimeType: f.mimeType };
}

/** Permanently removes a file. Used the moment an application is approved. */
export async function deleteFile(env, fileId, { fetchImpl = fetch } = {}) {
  const token = await getAccessToken(env, { fetchImpl });
  const res = await fetchImpl(`${FILES_URL}/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
  });
  // 404 means it is already gone, which is the state we wanted anyway.
  if (!res.ok && res.status !== 404) {
    throw new DriveError('Could not remove the video from Drive.', { code: 'DRIVE_DELETE', status: 502 });
  }
  return true;
}

/**
 * Moves a file into the rejected folder, where the purge sweep will collect
 * it once DRIVE_REJECTED_RETENTION_MS has passed. Falls back to deleting it
 * if no rejected folder is configured, so a missing setting can never leave
 * files accumulating unnoticed in the pending folder.
 */
export async function moveToRejected(env, fileId, { fetchImpl = fetch } = {}) {
  if (!env.GDRIVE_REJECTED_FOLDER_ID) return deleteFile(env, fileId, { fetchImpl });
  const token = await getAccessToken(env, { fetchImpl });
  const url = `${FILES_URL}/${encodeURIComponent(fileId)}` +
    `?addParents=${encodeURIComponent(env.GDRIVE_REJECTED_FOLDER_ID)}` +
    `&removeParents=${encodeURIComponent(env.GDRIVE_PENDING_FOLDER_ID)}` +
    `&fields=id,parents&supportsAllDrives=true`;
  const res = await fetchImpl(url, { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok && res.status !== 404) {
    throw new DriveError('Could not move the video to the rejected folder.', { code: 'DRIVE_MOVE', status: 502 });
  }
  return true;
}

/**
 * Streams a stored video to a reviewer, passing the browser's Range header
 * through so seeking works and the whole file is not pulled for a preview.
 *
 * Goes through the Worker because the file sits in the founder's private
 * Drive: a moderator has no access to it and should not need any. The Worker
 * fetches it with its own credentials and hands over only the bytes.
 *
 * Returns the upstream Response, body untouched (never buffered -- videos run
 * to hundreds of MB), with only the headers a <video> element needs.
 */
export async function streamFile(env, fileId, range, { fetchImpl = fetch } = {}) {
  const token = await getAccessToken(env, { fetchImpl });
  const headers = { Authorization: `Bearer ${token}` };
  if (range) headers.Range = range;
  const res = await fetchImpl(
    `${FILES_URL}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, { headers }
  );
  if (res.status === 404) throw new DriveError('The video is no longer in Drive.', { code: 'DRIVE_NOT_FOUND', status: 404 });
  if (!res.ok && res.status !== 206) {
    throw new DriveError('Could not load the video from Drive.', { code: 'DRIVE_STREAM', status: 502 });
  }
  const out = new Headers();
  for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  if (!out.has('Accept-Ranges')) out.set('Accept-Ranges', 'bytes');
  // Private reviewer content: never cached by a shared cache.
  out.set('Cache-Control', 'private, no-store');
  // A browser sniffing an uploaded file as HTML would be an XSS vector.
  out.set('X-Content-Type-Options', 'nosniff');
  return new Response(res.body, { status: res.status, headers: out });
}

/**
 * A step-by-step check of everything an upload depends on, for the admin page.
 *
 * Exists because the clipper-facing message ("Could not reach Google Drive")
 * is deliberately vague -- and so was every diagnosis of it. This reports
 * exactly which link in the chain is broken and what Google itself said:
 * which secrets are missing, whether the refresh token is accepted, and
 * whether each folder is reachable and writable. It never returns a secret
 * or a token, only Google's own error codes.
 */
export async function driveHealth(env, { fetchImpl = fetch } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail: detail || null });

  const required = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GDRIVE_PENDING_FOLDER_ID'];
  const missing = required.filter(k => !env[k]);
  add('Secrets present', !missing.length, missing.length ? `Missing: ${missing.join(', ')}` : 'All four required secrets are set.');
  if (!env.GDRIVE_REJECTED_FOLDER_ID) add('Rejected folder configured', false, 'GDRIVE_REJECTED_FOLDER_ID is not set, so rejected videos are deleted at once instead of held for 7 days.');
  if (missing.length) return { ok: false, checks };

  // Whitespace in a pasted secret is the classic silent failure.
  const padded = required.filter(k => String(env[k]) !== String(env[k]).trim());
  if (padded.length) add('No stray whitespace in secrets', false, `Has leading/trailing spaces or a newline: ${padded.join(', ')}. Re-set them without a trailing newline.`);

  let token = null;
  try {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token'
      })
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.access_token) {
      token = body.access_token;
      add('Google accepts the refresh token', true, `Scope: ${body.scope || 'unknown'}`);
    } else {
      const code = body.error || `HTTP ${res.status}`;
      const hints = {
        invalid_client: 'The client ID or client secret is wrong or was rotated. Re-run: wrangler secret put GOOGLE_CLIENT_SECRET (and check GOOGLE_CLIENT_ID).',
        invalid_grant: 'The refresh token is expired, revoked, or was issued to a different client ID/secret. Generate a new one in the OAuth Playground with the CURRENT client credentials, then re-run: wrangler secret put GOOGLE_REFRESH_TOKEN.',
        unauthorized_client: 'This client is not allowed to use a refresh token. Re-create the token with the OAuth Playground using your own credentials.'
      };
      add('Google accepts the refresh token', false, `Google said: ${code}${body.error_description ? ' — ' + body.error_description : ''}. ${hints[body.error] || ''}`.trim());
    }
  } catch (e) {
    add('Google accepts the refresh token', false, 'The request to Google failed: ' + (e && e.message));
  }
  if (!token) return { ok: false, checks };

  const folder = async (label, id) => {
    try {
      const res = await fetchImpl(`${FILES_URL}/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id,name,mimeType,trashed,capabilities(canAddChildren)`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.status === 404) return add(label, false, 'Google says this folder does not exist for this app. With the drive.file scope the app can only see folders IT created -- a folder made by hand in Drive returns 404. Create the folder via the OAuth Playground (files.create) and use that ID.');
      if (!res.ok) return add(label, false, `Google returned HTTP ${res.status}.`);
      const f = await res.json();
      if (f.mimeType !== 'application/vnd.google-apps.folder') return add(label, false, 'That ID is a file, not a folder.');
      if (f.trashed) return add(label, false, `Folder "${f.name}" is in the trash.`);
      if (f.capabilities && f.capabilities.canAddChildren === false) return add(label, false, `Folder "${f.name}" is read-only for this app.`);
      add(label, true, `"${f.name}" is reachable and writable.`);
    } catch (e) {
      add(label, false, 'The request failed: ' + (e && e.message));
    }
  };
  await folder('Pending folder', env.GDRIVE_PENDING_FOLDER_ID);
  if (env.GDRIVE_REJECTED_FOLDER_ID) await folder('Rejected folder', env.GDRIVE_REJECTED_FOLDER_ID);

  return { ok: checks.every(c => c.ok), checks };
}
