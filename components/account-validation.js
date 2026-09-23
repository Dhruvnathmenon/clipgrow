/* Rules for a new ClipGrow account's username and password.
 *
 * One file, imported by BOTH the Worker (src/signup.js) and the sign-up form
 * (login.html), so the message the form shows while someone types is the same
 * rule the server enforces at the end. Same idea as profile-validation.js.
 *
 * Each validator returns null when the value is acceptable, otherwise the
 * sentence to show the person. No dependencies, so it loads anywhere.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 24;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

// Names that read as ClipGrow itself, staff, or the system. Someone signing up as
// "admin" or "support" is either a mistake or an attempt to look official to
// other clippers.
const RESERVED = new Set([
  'admin', 'administrator', 'root', 'support', 'help', 'moderator', 'mod', 'staff', 'team',
  'clipgrow', 'clipcore', 'official', 'system', 'api', 'www', 'null', 'undefined', 'anonymous'
]);

// The passwords people actually pick first. Deliberately short: this stops the
// worst guesses, it is not a substitute for a long password.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd', '12345678', '123456789', '1234567890',
  '87654321', 'qwertyui', 'qwerty123', 'qwertyuiop', 'iloveyou', 'abcd1234', 'abc12345', 'letmein1',
  'welcome1', 'welcome123', 'admin123', 'clipgrow', 'clipgrow1', 'clipgrow123', '11111111', '00000000',
  '9876543210', '1q2w3e4r', 'india123', 'monkey123', 'dragon123'
]);

// Stored form: lowercase, no whitespace. Matches normalizeUsername() in db.js,
// which every login already runs input through.
export function normaliseUsername(input) {
  return String(input == null ? '' : input).trim().toLowerCase().replace(/\s+/g, '');
}

export function validateUsername(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return 'Choose a username.';
  // Rejected rather than silently squashed, so what someone typed is what they get.
  if (/\s/.test(raw)) return 'A username cannot contain spaces.';
  const s = normaliseUsername(raw);
  if (s.length < USERNAME_MIN) return `Use at least ${USERNAME_MIN} characters.`;
  if (s.length > USERNAME_MAX) return `Use at most ${USERNAME_MAX} characters.`;
  if (!/^[a-z0-9._-]+$/.test(s)) return 'Use only letters, numbers, dots, dashes and underscores.';
  if (!/^[a-z0-9]/.test(s) || !/[a-z0-9]$/.test(s)) return 'Start and end with a letter or number.';
  if (/[._-]{2,}/.test(s)) return 'Do not put two dots, dashes or underscores in a row.';
  if (RESERVED.has(s)) return 'That username is not available.';
  return null;
}

export function validatePassword(password, username) {
  const p = String(password == null ? '' : password);
  if (!p) return 'Choose a password.';
  if (p.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (p.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (/^(.)\1+$/.test(p)) return 'That password is too easy to guess.';
  if (COMMON_PASSWORDS.has(p.toLowerCase())) return 'That password is too easy to guess. Pick something less common.';
  const u = normaliseUsername(username);
  if (u && p.toLowerCase() === u) return 'Your password cannot be the same as your username.';
  return null;
}
