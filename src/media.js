// Clip preview images.
//
// Instagram serves thumbnails from a signed CDN URL that expires, so we copy
// the image into R2 once at submit time. R2 is optional: if the binding is not
// present (bucket not enabled on the account yet) we fall back to storing the
// raw URL, and the UI degrades to a placeholder once that URL lapses.

const MAX_THUMB_BYTES = 3 * 1024 * 1024;

export function hasMediaStore(env) {
  return !!(env && env.MEDIA);
}

export function thumbnailKey(mediaId) {
  return `thumbs/${String(mediaId).replace(/[^A-Za-z0-9_-]/g, '')}.jpg`;
}

/**
 * Copies a clip thumbnail into R2. Never throws: a missing preview image must
 * not stop a clip from being submitted.
 * @returns {Promise<string|null>} the R2 key, or null if it could not be stored
 */
export async function captureThumbnail(env, mediaId, sourceUrl) {
  if (!hasMediaStore(env) || !sourceUrl) return null;
  try {
    const res = await fetch(sourceUrl);
    if (!res.ok) return null;

    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return null;

    const length = Number(res.headers.get('content-length') || 0);
    if (length > MAX_THUMB_BYTES) return null;

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_THUMB_BYTES) return null;

    const key = thumbnailKey(mediaId);
    await env.MEDIA.put(key, buf, {
      httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' }
    });
    return key;
  } catch {
    return null;
  }
}

export async function deleteThumbnail(env, key) {
  if (!hasMediaStore(env) || !key) return;
  try {
    await env.MEDIA.delete(key);
  } catch {
    /* best effort */
  }
}

/** Serves a stored thumbnail, falling back to a redirect at the source URL. */
export async function serveThumbnail(env, key, fallbackUrl) {
  if (hasMediaStore(env) && key) {
    const obj = await env.MEDIA.get(key);
    if (obj) {
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('etag', obj.httpEtag);
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return new Response(obj.body, { headers });
    }
  }
  if (fallbackUrl) return Response.redirect(fallbackUrl, 302);
  return new Response(null, { status: 404 });
}
