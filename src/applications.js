// Campaign applications -- step 1 of joining a campaign.
//
// A clipper submits a video against a campaign, a moderator approves or
// rejects it with written feedback, and only an approved application unlocks
// step 2: connecting the social account, which is the existing
// tester_requests flow in src/access.js and is untouched by this file.
//
// This module owns the campaign_applications table the way access.js owns
// tester_requests -- routes call these functions, they do not write the
// table directly, so the attempt rules live in exactly one place.
//
// Nothing here ever reads or writes submissions.earning, frozen_earning,
// locked_at, locked_earning or payment_id. An application is decided before
// a clip can exist at all, so there is no money in scope by construction.

import { now } from './db.js';

// Three tries per campaign, then the clipper is removed from that campaign.
// Deliberately per campaign, not lifetime: a clipper who cannot hit one
// brand's style may be a good fit for another, and nothing is learned by
// banning them from the whole platform over it.
export const MAX_ATTEMPTS = 3;

export const APPLICATION_STATUSES = ['pending', 'approved', 'rejected'];

/**
 * Every application a clipper has filed for one campaign, newest first.
 * The full attempt history, which is what the clipper's own screen and any
 * later dispute both read.
 */
export async function applicationHistory(db, clipperId, campaignId) {
  const { results } = await db.prepare(
    `SELECT id, video_url, attempt, status, reviewer_name, reviewer_note,
            reviewed_at, created_at
       FROM campaign_applications
      WHERE clipper_id = ? AND campaign_id = ?
      ORDER BY attempt DESC, id DESC`
  ).bind(clipperId, campaignId).all();
  return results || [];
}

/**
 * The one thing every caller actually wants to know: where does this clipper
 * stand on this campaign, and what may they do next.
 *
 * Derived from the rows rather than stored, so it cannot drift from the
 * history it describes -- the same reason bot_score's tier is computed on
 * read in src/bot-detection.js instead of being written alongside the score.
 */
export async function applicationState(db, clipperId, campaignId) {
  const rows = await applicationHistory(db, clipperId, campaignId);
  const approved = rows.find(r => r.status === 'approved') || null;
  const pending = rows.find(r => r.status === 'pending') || null;
  const rejections = rows.filter(r => r.status === 'rejected').length;
  const attemptsUsed = rows.filter(r => r.attempt > 0).length;

  let state;
  if (approved) state = 'approved';
  else if (pending) state = 'pending';
  else if (rejections >= MAX_ATTEMPTS) state = 'exhausted';
  else if (rows.length) state = 'rejected';
  else state = 'none';

  return {
    state,
    approved,
    pending,
    rejections,
    attempts_used: attemptsUsed,
    attempts_left: Math.max(0, MAX_ATTEMPTS - rejections),
    // The single question the connect-account gate asks.
    may_connect: !!approved,
    // Whether Submit should be offered at all.
    may_submit: !approved && !pending && rejections < MAX_ATTEMPTS,
    history: rows
  };
}

/**
 * Files one attempt. Returns { error, status } on refusal rather than
 * throwing, matching submitAccessRequest's shape in src/access.js.
 *
 * The caller is responsible for having checked the campaign is open and the
 * clipper actually holds a participation -- those are route-level concerns
 * with their own error messages, and access.js draws the same line.
 */
export async function submitApplication(db, { clipperId, campaignId, videoUrl }) {
  const url = String(videoUrl || '').trim();
  if (!url) return { error: 'Paste a link to your video.', status: 400 };
  if (!/^https?:\/\//i.test(url)) return { error: 'That does not look like a link. Paste the full URL, starting with https://', status: 400 };
  if (url.length > 2000) return { error: 'That link is too long.', status: 400 };

  const state = await applicationState(db, clipperId, campaignId);
  if (state.approved) return { error: 'Your video for this campaign has already been approved.', status: 409 };
  if (state.pending) return { error: 'Your video is already with a reviewer. You will hear back on this one before you can send another.', status: 409 };
  if (state.rejections >= MAX_ATTEMPTS) {
    return { error: `You have used all ${MAX_ATTEMPTS} attempts for this campaign.`, status: 403 };
  }

  const attempt = state.rejections + 1;
  const ts = now();
  try {
    const res = await db.prepare(
      `INSERT INTO campaign_applications
         (clipper_id, campaign_id, video_url, attempt, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`
    ).bind(clipperId, campaignId, url, attempt, ts).run();
    return { ok: true, id: res.meta.last_row_id, attempt, attempts_left: MAX_ATTEMPTS - state.rejections };
  } catch (e) {
    // The one-pending partial unique index fired: two submits raced. The
    // second is a duplicate of the first, not a new attempt.
    if (/UNIQUE constraint/i.test(e.message || '')) {
      return { error: 'Your video is already with a reviewer.', status: 409 };
    }
    throw e;
  }
}

/**
 * Records a verdict. On the final rejection the clipper is removed from the
 * campaign, which is the whole point of a capped process -- see the comment
 * on that UPDATE below for why it is safe to do inline here.
 */
export async function reviewApplication(db, applicationId, { verdict, note, reviewerType, reviewerId, reviewerName }) {
  if (verdict !== 'approved' && verdict !== 'rejected') {
    return { error: 'A verdict must be approved or rejected.', status: 400 };
  }
  const text = String(note || '').trim();
  // Required on both verdicts. A rejection without a reason costs the clipper
  // one of three tries and tells them nothing about how to spend the next.
  if (!text) return { error: 'Leave a note explaining the decision.', status: 400 };

  const app = await db.prepare(
    'SELECT * FROM campaign_applications WHERE id = ?'
  ).bind(applicationId).first();
  if (!app) return { error: 'Application not found.', status: 404 };
  if (app.status !== 'pending') return { error: 'That application has already been reviewed.', status: 409 };

  const ts = now();
  const res = await db.prepare(
    `UPDATE campaign_applications
        SET status = ?, reviewer_type = ?, reviewer_id = ?, reviewer_name = ?,
            reviewer_note = ?, reviewed_at = ?
      WHERE id = ? AND status = 'pending'`
  ).bind(verdict, reviewerType || null, reviewerId || null, reviewerName || null,
         text, ts, applicationId).run();

  // Guarded the same way every conditional write in this codebase is: if the
  // row moved under us, another reviewer got there first and this verdict is
  // not the one that counts.
  if (!(res.meta && res.meta.changes)) {
    return { error: 'That application has already been reviewed.', status: 409 };
  }

  let removedFromCampaign = false;
  if (verdict === 'rejected') {
    const state = await applicationState(db, app.clipper_id, app.campaign_id);
    if (state.rejections >= MAX_ATTEMPTS) {
      // Out of attempts: the clipper leaves this campaign.
      //
      // Reuses the existing 'kicked' status rather than inventing one, so
      // every screen that already understands a kicked participation keeps
      // working, and an admin can reverse it from the panel they already
      // have. The freeze/reallocate dance admin.js performs on a kick is
      // deliberately NOT copied here: a clipper who has not passed step 1
      // has never reached step 2, so they hold no connected account and no
      // submissions on this campaign -- there is no earning to freeze and
      // no budget to hand back. status_changed_at is not written because
      // the column does not exist (dropped by migration 032).
      const kicked = await db.prepare(
        `UPDATE participations
            SET status = 'kicked', status_note = ?, inactive_at = ?
          WHERE clipper_id = ? AND campaign_id = ? AND status != 'kicked'`
      ).bind(`Removed automatically after ${MAX_ATTEMPTS} rejected verification videos.`,
             ts, app.clipper_id, app.campaign_id).run();
      removedFromCampaign = !!(kicked.meta && kicked.meta.changes);
    }
  }

  return { ok: true, verdict, removed_from_campaign: removedFromCampaign };
}

/**
 * The moderator's work queue, grouped into one bucket per campaign.
 *
 * Ordered oldest-submitted first, which is what first-come-first-served
 * means in practice: the clipper who has been waiting longest is reviewed
 * first. Ordering newest-first would do the opposite -- the earliest
 * submission would sink further down the list every time someone else
 * submitted, and could sit unreviewed indefinitely.
 *
 * Grouped here rather than in the page so the ordering and the counts come
 * from the same query that produced the rows, and a tab can never show a
 * count that disagrees with what opening it reveals.
 */
export async function applicationQueue(db, { limit = 300 } = {}) {
  const { results } = await db.prepare(
    `SELECT a.id, a.clipper_id, a.campaign_id, a.video_url, a.attempt, a.created_at,
            cl.username AS clipper_username, cl.display_name AS clipper_display_name,
            c.name AS campaign_name, c.status AS campaign_status,
            (SELECT COUNT(*) FROM campaign_applications r
              WHERE r.clipper_id = a.clipper_id AND r.campaign_id = a.campaign_id
                AND r.status = 'rejected') AS prior_rejections
       FROM campaign_applications a
       JOIN clippers cl ON cl.id = a.clipper_id
       JOIN campaigns c ON c.id = a.campaign_id
      WHERE a.status = 'pending'
      ORDER BY a.created_at ASC
      LIMIT ?`
  ).bind(limit).all();

  const applications = (results || []).map(r => ({
    ...r,
    attempts_left: Math.max(0, MAX_ATTEMPTS - r.prior_rejections),
    // Surfaced so a reviewer knows this verdict is the one that removes them.
    is_final_attempt: r.prior_rejections >= MAX_ATTEMPTS - 1,
    waiting_ms: Math.max(0, Date.now() - r.created_at)
  }));

  // One tab per campaign that actually has something waiting. A campaign with
  // an empty queue gets no tab rather than an empty one, so the tab strip is
  // a list of work rather than a list of campaigns.
  const byCampaign = new Map();
  for (const a of applications) {
    if (!byCampaign.has(a.campaign_id)) {
      byCampaign.set(a.campaign_id, {
        campaign_id: a.campaign_id,
        campaign_name: a.campaign_name,
        campaign_status: a.campaign_status,
        pending: 0,
        // Drives the "longest wait" figure on the tab -- the rows are already
        // oldest-first, so the first one in is the oldest.
        oldest_created_at: a.created_at
      });
    }
    byCampaign.get(a.campaign_id).pending++;
  }

  // Campaigns with the longest-waiting clipper first, so the tab that needs
  // attention most is the one nearest the left.
  const campaigns = [...byCampaign.values()].sort((x, y) => x.oldest_created_at - y.oldest_created_at);

  return { applications, campaigns, total: applications.length };
}
