// One account per person: the email, phone number and Discord username each belong
// to at most one live account.
//
// What counts as "the same" lives in components/profile-validation.js (emailKey,
// phoneKey, discordKey) so the sign-up form, the profile form and this file cannot
// disagree. The database holds the keys unique (migration 051); the checks here
// only exist to say WHICH detail collided, in words, before anything is written.
// They are not the enforcement -- the unique indexes are -- so two requests racing
// past a check still cannot both get in.

import { emailKey, phoneKey, discordKey } from '../components/profile-validation.js';

export const DUPLICATE_MESSAGES = {
  email: 'That email is already used by another ClipGrow account. Log in to that account, or use a different email.',
  phone: 'That phone number is already used by another ClipGrow account. Log in to that account, or use a different number.',
  discord: 'That Discord username is already used by another ClipGrow account. Log in to that account, or use a different one.'
};

const COLUMN = { email: 'email_key', phone: 'phone_key', discord: 'discord_key' };

/** The three keys for a set of details (any may be absent). */
export function identityKeys({ email, contact_number, discord_username } = {}) {
  return { email_key: emailKey(email), phone_key: phoneKey(contact_number), discord_key: discordKey(discord_username) };
}

/**
 * Which detail, if any, another live account already holds. `exceptId` is the
 * clipper editing their own profile, who obviously may keep what they have.
 * Returns 'email' | 'phone' | 'discord' | null.
 */
export async function identityConflict(db, keys, exceptId = null) {
  for (const field of ['email', 'phone', 'discord']) {
    const key = keys[COLUMN[field]];
    if (!key) continue;
    const row = await db.prepare(
      `SELECT id FROM clippers WHERE ${COLUMN[field]} = ? AND status != 'deleted' AND id != ? LIMIT 1`
    ).bind(key, exceptId == null ? -1 : exceptId).first();
    if (row) return field;
  }
  return null;
}

/** From a database UNIQUE error, which detail it was about; null if it was about something else. */
export function duplicateField(e) {
  const text = String(e && e.message);
  if (!/UNIQUE/i.test(text)) return null;
  for (const [field, col] of Object.entries(COLUMN)) if (text.includes(col)) return field;
  return null;
}
