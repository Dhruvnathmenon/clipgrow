// Validation and shaping for the material a clipper works from: reference
// videos and raw footage sources. Both take a Drive link or a link to one of
// the listed social platforms -- a reference is often simply a video that is
// already posted, so it is not limited to Drive.
//
// Strict on purpose. These links are rendered as clickable cards to clippers,
// so an unvetted URL is a phishing surface with ClipGrow's name on it. Only
// hosts on an allowlist get through, https only, and the host is checked on
// the parsed URL -- never by substring, which "drive.google.com.evil.com" or
// "evil.com/?drive.google.com" would walk straight past.

export const MAX_REFERENCE_LINKS = 10;
export const MAX_RAW_SOURCES = 20;
const MAX_URL_LENGTH = 500;
const MAX_LABEL_LENGTH = 60;

const DRIVE_HOSTS = new Set(['drive.google.com']);

// host (and any subdomain of it) -> the kind shown to the clipper.
const SOCIAL_HOSTS = {
  'instagram.com': 'instagram',
  'youtube.com': 'youtube',
  'youtu.be': 'youtube',
  'tiktok.com': 'tiktok',
  'x.com': 'x',
  'twitter.com': 'x',
  'facebook.com': 'facebook',
  'fb.watch': 'facebook',
  'twitch.tv': 'twitch',
  'snapchat.com': 'snapchat'
};

function parseHttps(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { error: 'A link is empty.' };
  if (text.length > MAX_URL_LENGTH) return { error: 'A link is too long.' };
  let u;
  try { u = new URL(text); } catch (e) { return { error: `"${text.slice(0, 40)}" is not a valid link.` }; }
  if (u.protocol !== 'https:') return { error: 'Links must start with https://' };
  // Credentials in a URL (https://drive.google.com@evil.com) are the classic
  // way to make a link read as one host and land on another.
  if (u.username || u.password) return { error: 'That link is not allowed.' };
  return { url: u };
}

const hostIs = (host, base) => host === base || host.endsWith('.' + base);

/** A Drive link the clipper can open: a file or a folder. */
export function driveLink(raw) {
  const p = parseHttps(raw);
  if (p.error) return p;
  const host = p.url.hostname.toLowerCase();
  if (!DRIVE_HOSTS.has(host)) return { error: 'Only Google Drive links are allowed here (drive.google.com).' };
  // A bare drive.google.com root is not a file or a folder.
  if (!/\/(file|drive|open|folders|uc)\b/.test(p.url.pathname) && !p.url.searchParams.get('id')) {
    return { error: 'That Drive link does not point to a file or folder.' };
  }
  return { url: p.url.toString() };
}

/** Kind of an allowed raw-footage link, or an error. */
export function sourceLink(raw) {
  const p = parseHttps(raw);
  if (p.error) return p;
  const host = p.url.hostname.toLowerCase();
  if (DRIVE_HOSTS.has(host)) {
    const d = driveLink(raw);
    return d.error ? d : { url: d.url, kind: 'drive' };
  }
  for (const [base, kind] of Object.entries(SOCIAL_HOSTS)) {
    if (hostIs(host, base)) return { url: p.url.toString(), kind };
  }
  return { error: 'Use a Google Drive link, or a link to Instagram, YouTube, TikTok, X, Facebook, Twitch or Snapchat.' };
}

const cleanLabel = l => String(l == null ? '' : l).replace(/[\x00-\x1f]/g, ' ').trim().slice(0, MAX_LABEL_LENGTH);

/**
 * Accepts an array, or one link per line as pasted text -- an admin pasting
 * five links should not have to add them one at a time.
 */
function toList(input) {
  if (input == null || input === '') return [];
  if (Array.isArray(input)) return input;
  return String(input).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

/** Turns whatever the admin form sent into a clean array, or an error naming the first bad entry. */
export function normaliseReferenceLinks(input) {
  const out = [];
  const seen = new Set();
  for (const item of toList(input)) {
    const r = sourceLink(typeof item === 'object' && item ? item.url : item);
    if (r.error) return { error: `Reference video: ${r.error}` };
    if (seen.has(r.url)) continue;
    seen.add(r.url); out.push(r.url);
  }
  if (out.length > MAX_REFERENCE_LINKS) return { error: `At most ${MAX_REFERENCE_LINKS} reference links.` };
  return { value: out };
}

export function normaliseRawSources(input) {
  const out = [];
  const seen = new Set();
  for (const item of toList(input)) {
    const isObj = item && typeof item === 'object';
    const r = sourceLink(isObj ? item.url : item);
    if (r.error) return { error: `Raw footage: ${r.error}` };
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({ url: r.url, kind: r.kind, label: cleanLabel(isObj ? item.label : '') });
  }
  if (out.length > MAX_RAW_SOURCES) return { error: `At most ${MAX_RAW_SOURCES} raw footage sources.` };
  return { value: out };
}

/** Stored JSON -> arrays, tolerant of NULL and of anything malformed. */
export function readStored(row) {
  const parse = s => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
  return { reference_links: parse(row && row.reference_links), raw_sources: parse(row && row.raw_sources) };
}
