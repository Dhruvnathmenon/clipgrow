// Self-serve clipper sign-up: the switch, and the brake.
//
// Sign-up is the first place an anonymous visitor can make ClipGrow write a row,
// so it is opened deliberately (CLIPPER_SIGNUP in wrangler.jsonc) and limited. An
// account that is created can do nothing on its own: it still needs complete
// profile details, a verified Discord (once required), and an approved video
// before it can connect an account, so the limits below only have to stop floods,
// not judge people.

export const signupOpen = env => String(env.CLIPPER_SIGNUP || '').toLowerCase() === 'open';

// Per address, and site-wide as a circuit breaker for a bot spread over many
// addresses. The per-address numbers are generous on purpose: mobile carriers
// in India put many customers behind one address, and a real announcement can
// bring a lot of people to sign up together.
export const LIMITS = { perIpHour: 6, perIpDay: 15, globalHour: 200 };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// A salted hash, never the address: enough to count sign-ups per address, useless
// for finding out who anyone is. Salted with the session secret so the hashes
// cannot be reversed by trying every address.
export async function hashIp(ip, secret) {
  const data = new TextEncoder().encode(`${secret}|signup|${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}

// null = fine, otherwise how long until the caller may try again.
export async function signupBlockedFor(db, ipHash, at = Date.now()) {
  const count = async (sql, ...bind) => (await db.prepare(sql).bind(...bind).first()).n || 0;
  if (await count('SELECT COUNT(*) AS n FROM signup_attempts WHERE created_at > ?', at - HOUR) >= LIMITS.globalHour) {
    return { scope: 'site', minutes: 30 };
  }
  if (await count('SELECT COUNT(*) AS n FROM signup_attempts WHERE ip_hash = ? AND created_at > ?', ipHash, at - HOUR) >= LIMITS.perIpHour) {
    return { scope: 'address', minutes: 60 };
  }
  if (await count('SELECT COUNT(*) AS n FROM signup_attempts WHERE ip_hash = ? AND created_at > ?', ipHash, at - DAY) >= LIMITS.perIpDay) {
    return { scope: 'address', minutes: 24 * 60 };
  }
  return null;
}

export async function recordSignup(db, ipHash, at = Date.now()) {
  await db.prepare('INSERT INTO signup_attempts (ip_hash, created_at) VALUES (?, ?)').bind(ipHash, at).run();
  await db.prepare('DELETE FROM signup_attempts WHERE created_at < ?').bind(at - 2 * DAY).run();
}
