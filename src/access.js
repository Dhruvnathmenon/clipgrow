import { now } from './db.js';
import { platformLabel } from './platforms.js';

// Account onboarding gate.
//
// Both platforms refuse strangers until ClipGrow passes their app review:
// Instagram needs the account added as a Meta app Tester, YouTube needs the
// Google account on the Cloud project's Test users list. Neither can be
// automated away, and both fail with platform errors that mean nothing to a
// clipper.
//
// So the approval is modelled as an explicit, visible step instead. A clipper
// is only ever shown ONE next action, and that action is always one that can
// actually succeed:
//
//   none -> requested -> approved -> connected
//              |
//              +-> rejected (with a reason, and they can request again)
//
// The whole point is that "Connect" never appears until connecting will work.

export const ACCESS_STATES = ['none', 'requested', 'rejected', 'approved', 'connected'];

/** What a clipper must hand over for each platform, and how it is checked. */
export const IDENTIFIER_SPEC = {
  instagram: {
    label: 'Instagram username',
    placeholder: 'yourhandle',
    hint: 'The exact handle of the account you will post this campaign from. It must be a Professional (Creator or Business) account.',
    normalise: (v) => String(v || '').trim().replace(/^@+/, ''),
    validate: (v) => {
      if (!v) return 'Enter your Instagram username';
      if (!/^[A-Za-z0-9._]{1,30}$/.test(v)) return 'That does not look like an Instagram username. Use only letters, numbers, dots and underscores.';
      return null;
    }
  },
  youtube: {
    label: 'Google account email',
    placeholder: 'you@gmail.com',
    hint: 'The Google account that owns your YouTube channel. ClipGrow has to grant this exact address access before you can connect.',
    normalise: (v) => String(v || '').trim().toLowerCase(),
    validate: (v) => {
      if (!v) return 'Enter the Google account email for your channel';
      // Deliberately permissive: the address only has to be good enough to
      // paste into Google Cloud Console, and over-strict email regexes reject
      // valid addresses far more often than they catch typos.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'That does not look like an email address';
      return null;
    }
  }
};

export function normaliseIdentifier(platform, value) {
  const spec = IDENTIFIER_SPEC[platform];
  return spec ? spec.normalise(value) : String(value || '').trim();
}

export function validateIdentifier(platform, value) {
  const spec = IDENTIFIER_SPEC[platform];
  if (!spec) return 'Unknown platform';
  return spec.validate(value);
}

/** The access request covering one clipper's use of one platform on one campaign. */
export function getAccessRequest(db, clipperId, campaignId, platform) {
  return db.prepare(
    `SELECT * FROM tester_requests
     WHERE clipper_id = ? AND campaign_id = ? AND platform = ?
     ORDER BY requested_at DESC LIMIT 1`
  ).bind(clipperId, campaignId, platform).first();
}

/**
 * Where this clipper stands for one platform on one campaign.
 *
 * `account` is the connected social account, if any -- passed in rather than
 * looked up here so callers that already have it (the campaigns list, which
 * loads accounts in bulk) don't re-query per platform.
 */
export function accessState(request, account) {
  if (account && account.status !== 'revoked') return 'connected';
  if (!request) return 'none';
  if (request.status === 'rejected') return 'rejected';
  if (request.status === 'confirmed') return 'approved';
  return 'requested';   // 'requested' or the legacy 'invited'
}

/**
 * The single next action a clipper should see, in their words.
 *
 * Kept here rather than in the page templates so the clipper dashboard, the
 * admin view and any future surface describe the same situation identically.
 */
export function accessGuidance(state, platform, request) {
  const label = platformLabel(platform);
  const isYt = platform === 'youtube';

  switch (state) {
    case 'none':
      return {
        title: `Step 1 of 2 — request ${label} access`,
        body: isYt
          ? 'Tell us the Google account that owns your channel. ClipGrow has to grant it access before YouTube will let you connect.'
          : `Tell us the Instagram account you will post from. ClipGrow has to add it as an approved tester before Instagram will let you connect.`,
        action: 'request'
      };
    case 'requested':
      return {
        title: `Step 1 of 2 — waiting for ClipGrow`,
        body: isYt
          ? `We have your address (${request ? request.identifier : ''}) and are granting it access. This is a manual step on our side, usually within a day. You will see the Connect button here as soon as it is done.`
          : `We have your handle (@${request ? request.identifier : ''}) and are adding it as an approved tester. This is a manual step on our side, usually within a day. You will see the Connect button here as soon as it is done.`,
        action: 'wait'
      };
    case 'rejected':
      return {
        title: `${label} access was not approved`,
        body: (request && request.note)
          ? request.note
          : `Check that what you entered is correct, then request again.`,
        action: 'request'
      };
    case 'approved':
      return {
        title: `Step 2 of 2 — connect ${label}`,
        body: isYt
          ? 'Your Google account has been granted access. Click Connect, sign in with that same Google account, and approve every permission it asks for.'
          : 'Your account has been approved. Instagram will have sent you a tester invite — accept it in the Instagram app under Settings and privacy → Apps and websites → Tester invites, then click Connect and tap Allow on every permission.',
        action: 'connect'
      };
    case 'connected':
      return { title: `${label} connected`, body: '', action: 'none' };
    default:
      return { title: '', body: '', action: 'none' };
  }
}

/**
 * Records a clipper's request for access. Re-requesting after a rejection (or
 * with a corrected handle) updates the existing row rather than piling up
 * duplicates for the admin to wade through.
 */
export async function submitAccessRequest(db, { clipperId, campaignId, platform, identifier }) {
  const existing = await getAccessRequest(db, clipperId, campaignId, platform);

  if (existing) {
    // An approved request is not re-openable by the clipper: letting them
    // silently swap the identifier after approval would mean the account we
    // vetted and the account they connect are different ones.
    if (existing.status === 'confirmed') {
      return { ok: true, request: existing, already: true };
    }
    await db.prepare(
      `UPDATE tester_requests
       SET identifier = ?, ig_username = ?, status = 'requested', note = NULL, requested_at = ?
       WHERE id = ?`
    ).bind(identifier, identifier, now(), existing.id).run();
    return { ok: true, request: await getAccessRequest(db, clipperId, campaignId, platform) };
  }

  await db.prepare(
    `INSERT INTO tester_requests (clipper_id, ig_username, identifier, platform, status, campaign_id, requested_at)
     VALUES (?, ?, ?, ?, 'requested', ?, ?)`
  ).bind(clipperId, identifier, identifier, platform, campaignId, now()).run();

  return { ok: true, request: await getAccessRequest(db, clipperId, campaignId, platform) };
}

/**
 * Whether this clipper may start OAuth for a platform on a campaign.
 *
 * Enforced on the server, not just by hiding the button, because the OAuth
 * start URL is a plain link a clipper could keep from an earlier session or
 * simply type. An unapproved attempt would fail at the platform anyway -- this
 * just makes it fail with an explanation instead of a raw platform error.
 */
export async function canConnect(db, clipperId, campaignId, platform) {
  const req = await getAccessRequest(db, clipperId, campaignId, platform);
  if (req && req.status === 'confirmed') return { allowed: true };

  const state = accessState(req, null);
  const guidance = accessGuidance(state, platform, req);
  return { allowed: false, state, reason: guidance.body, title: guidance.title };
}
