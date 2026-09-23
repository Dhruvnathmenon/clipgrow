// The one definition of what a valid clipper profile looks like.
//
// An ES module on purpose, and served from /components: the Worker imports it
// (src/db.js re-exports these, so every existing caller keeps working) AND the
// dashboard imports the very same file in the browser. The form's live
// per-field messages and the server's final say therefore cannot drift apart --
// there is one regex per field, in one place, and a value the form accepts is
// a value the server accepts.
//
// Each validate* returns null when the value is fine, or a short message the
// clipper can act on. Each normalise* is what gets stored.

/* ------------------------------------------------------------------ names */

/** Trim and collapse runs of whitespace, so "Ravi   Kumar " is "Ravi Kumar". */
export function normaliseName(input) {
  return String(input == null ? '' : input).replace(/\s+/g, ' ').trim();
}

/**
 * A real person's name: letters (any script, so Devanagari, Tamil and the like
 * are fine), spaces, dots, apostrophes and hyphens -- no digits, no symbols,
 * no emoji. At least two letters, so "A" and "." are refused.
 *
 * Deliberately does NOT insist on two words: plenty of people, especially in
 * South India, have a single legal name, and a form that rejects a real name is
 * worse than one that lets an odd one through.
 */
export function validatePersonName(input, label = 'name') {
  const v = normaliseName(input);
  if (!v) return `Enter your ${label}`;
  if (v.length > 100) return `That ${label} is too long`;
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u.test(v)) {
    return `Your ${label} can only contain letters, spaces, dots, apostrophes and hyphens.`;
  }
  if ((v.match(/\p{L}/gu) || []).length < 2) return `That does not look like a real ${label}.`;
  return null;
}

/* ------------------------------------------------------------------ email */

export function normaliseEmail(input) {
  return String(input == null ? '' : input).trim().toLowerCase();
}

// The mistyped domains that account for most bad addresses. Catching them at
// entry is far cheaper than discovering later that a payout notice bounced.
const EMAIL_TYPOS = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gamil.com': 'gmail.com',
  'gmail.con': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.cm': 'gmail.com',
  'gmaill.com': 'gmail.com', 'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com',
  'hotmial.com': 'hotmail.com', 'outlok.com': 'outlook.com'
};

export function validateEmail(input) {
  const v = normaliseEmail(input);
  if (!v) return 'Enter an email address';
  if (v.length > 254) return 'That email address is too long.';
  // local part: letters, digits and . _ % + - (no leading/trailing/double dot);
  // domain: dot-separated labels of letters/digits/hyphens, TLD of 2+ letters.
  const m = /^([a-z0-9._%+-]{1,64})@((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})$/.exec(v);
  if (!m || m[1].startsWith('.') || m[1].endsWith('.') || m[1].includes('..')) {
    return 'That does not look like a valid email address. It should look like name@example.com.';
  }
  if (EMAIL_TYPOS[m[2]]) return `Did you mean ${m[1]}@${EMAIL_TYPOS[m[2]]}?`;
  return null;
}

/* ---------------------------------------------------------- contact number */

/**
 * Strips everything but digits, then drops a leading '91' or '0' country/trunk
 * prefix so '+91 98765 43210', '098765 43210' and '9876543210' all normalise to
 * the same 10-digit number.
 */
export function normaliseContactNumber(input) {
  let v = String(input == null ? '' : input).replace(/\D/g, '');
  if (v.length === 12 && v.startsWith('91')) v = v.slice(2);
  else if (v.length === 11 && v.startsWith('0')) v = v.slice(1);
  return v;
}

export function validateContactNumber(input) {
  const v = normaliseContactNumber(input);
  if (!v) return 'Enter a contact number';
  // Ten digits, starting 6-9 as every Indian mobile number does.
  if (!/^[6-9]\d{9}$/.test(v)) return 'That does not look like a 10-digit Indian mobile number.';
  // 9999999999 and friends are placeholders, not numbers anyone can be reached on.
  if (/^(\d)\1{9}$/.test(v)) return 'That number looks like a placeholder. Enter the number you can be reached on.';
  return null;
}

/* ------------------------------------------------------------------- UPI */

export function normaliseUpiId(input) {
  return String(input == null ? '' : input).trim().replace(/\s+/g, '');
}

/**
 * <handle>@<bank/PSP>, e.g. 9999999999@upi or name@oksbi. The handle is letters,
 * digits and . _ - (starting with a letter or digit); the PSP is letters only.
 * There is no fixed registry of PSP suffixes, so the suffix is checked for
 * shape but never against a list -- a clipper must not be blocked by a bank
 * ClipGrow has not heard of.
 */
export function validateUpiId(input) {
  const v = normaliseUpiId(input);
  if (!v) return 'Enter a UPI ID';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z]{2,64}$/.test(v)) {
    return 'That does not look like a UPI ID. It should look like yourname@bank, for example 9999999999@upi.';
  }
  return null;
}

/* ---------------------------------------------------------------- Discord */

// Strips a leading "@" (people paste it either way) and lowercases, since
// Discord's own unique @username is always lowercase.
export function normaliseDiscordUsername(input) {
  return String(input == null ? '' : input).trim().replace(/^@/, '').toLowerCase();
}

/**
 * Empty is valid HERE -- the admin edit endpoint relies on that to leave it
 * blank on a clipper's behalf. The clipper's own profile requires it via
 * REQUIRED_FIELDS below.
 */
export function validateDiscordUsername(input) {
  const v = normaliseDiscordUsername(input);
  if (!v) return null;
  if (v.length < 2 || v.length > 32 || !/^[a-z0-9_.]+$/.test(v) || v.startsWith('.') || v.endsWith('.') || v.includes('..')) {
    return "That doesn't look like a Discord username -- 2-32 characters, lowercase letters/numbers/underscores/periods only. Find it under Discord Settings > My Account.";
  }
  return null;
}

/* ---------------------------------------------------- the whole profile */

/**
 * Every field a clipper must have on file, in the order the form shows them.
 * `key` is the clippers-table column (and the /api/clipper/me field), `field`
 * is the form's key, `check` returns an error message or null.
 */
export const REQUIRED_FIELDS = [
  { key: 'email', field: 'email', label: 'Email', check: validateEmail },
  { key: 'contact_number', field: 'contactNumber', label: 'Contact number', check: validateContactNumber },
  { key: 'upi_id', field: 'upiId', label: 'UPI ID', check: validateUpiId },
  { key: 'upi_account_name', field: 'accountName', label: 'Name on the UPI account', check: v => validatePersonName(v, 'name on the UPI account') },
  { key: 'legal_name', field: 'legalName', label: 'Legal full name', check: v => validatePersonName(v, 'legal name') },
  {
    key: 'discord_username', field: 'discordUsername', label: 'Discord username',
    check: v => (normaliseDiscordUsername(v) ? validateDiscordUsername(v) : 'Enter your Discord username')
  }
];

/**
 * The fields of a stored clipper row that are missing OR no longer valid.
 * Used to decide whether to make someone fill the form in. Checking validity
 * as well as presence is what brings clippers who entered details under the old,
 * looser rules up to the current standard.
 */
export function profileProblems(clipper) {
  const c = clipper || {};
  return REQUIRED_FIELDS
    .map(f => ({ key: f.key, field: f.field, label: f.label, error: f.check(c[f.key]) }))
    .filter(p => p.error);
}

export function profileComplete(clipper) {
  return profileProblems(clipper).length === 0;
}

/* ------------------------------------------------- one account per person
 *
 * "Is this the same person's email / number / Discord?" is not the same question
 * as "is this the same string?". Someone determined to make a second account
 * types name@gmail.com again as n.a.m.e@gmail.com or name+2@gmail.com, which
 * Gmail delivers to the same inbox. These keys collapse every spelling of the
 * same address to one value, and that value -- never the typed text -- is what
 * the database holds unique.
 *
 * null means "nothing to compare" (empty or not a real value), and the database
 * lets any number of rows have a null key.
 */

// Gmail ignores dots in the name and treats googlemail.com as gmail.com. A "+tag"
// after the name is delivered to the same mailbox on nearly every provider, so it
// is dropped everywhere: the rare address where "+" is a real part of the name is
// a far smaller loss than an open door to unlimited accounts.
export function emailKey(input) {
  const v = normaliseEmail(input);
  const at = v.lastIndexOf('@');
  if (at < 1) return null;
  let name = v.slice(0, at);
  let domain = v.slice(at + 1);
  const plus = name.indexOf('+');
  if (plus >= 0) name = name.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') name = name.replace(/\./g, '');
  return name && domain ? `${name}@${domain}` : null;
}

// The normalised ten digits, so +91 98765 43210, 098765 43210 and 9876543210
// are one number. Anything that is not a plausible number has no key.
export function phoneKey(input) {
  const v = normaliseContactNumber(input);
  return /^[6-9]\d{9}$/.test(v) ? v : null;
}

export function discordKey(input) {
  return normaliseDiscordUsername(input) || null;
}
