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
import { deleteFile, moveToRejected, DRIVE_REJECTED_RETENTION_MS } from './drive.js';

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
export async function submitApplication(db, { clipperId, campaignId, videoUrl, file = null }) {
  // Either an attached file (the normal path, already verified against Drive
  // by the caller) or a pasted link. One of the two is required -- a
  // submission with neither is nothing to review.
  const url = String(videoUrl || '').trim();
  if (!file) {
    if (!url) return { error: 'Attach your video, or paste a link to it.', status: 400 };
    if (!/^https?:\/\//i.test(url)) return { error: 'That does not look like a link. Paste the full URL, starting with https://', status: 400 };
    if (url.length > 2000) return { error: 'That link is too long.', status: 400 };
  }

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
         (clipper_id, campaign_id, video_url, drive_file_id, file_name, file_size,
          attempt, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).bind(clipperId, campaignId, url || null,
           file ? file.id : null, file ? file.name : null, file ? file.size : null,
           attempt, ts).run();
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
export async function reviewApplication(db, applicationId, { verdict, note, reviewerType, reviewerId, reviewerName, env = null }) {
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

  // The file's fate follows the verdict. Approved has served its purpose and
  // goes at once; rejected is kept for a week so a contested decision can
  // still be checked, then swept by purgeExpiredRejections.
  //
  // Deliberately AFTER the verdict is committed, and deliberately unable to
  // fail the review: a moderator's decision is the thing that matters, and
  // Drive being briefly unreachable must not cost them the verdict they just
  // made or leave the application stuck pending. A file that survives its
  // verdict is caught by the same purge sweep on a later pass, because that
  // sweep reads the row's status rather than trusting this to have run.
  let fileHandled = null;
  if (env && app.drive_file_id) {
    try {
      if (verdict === 'approved') {
        await deleteFile(env, app.drive_file_id);
        // Cleared only for a delete. A rejected file still exists, in the
        // rejected folder, and the id is what lets the purge sweep find it
        // a week from now.
        await db.prepare('UPDATE campaign_applications SET drive_file_id = NULL WHERE id = ?')
          .bind(applicationId).run();
        fileHandled = 'deleted';
      } else {
        await moveToRejected(env, app.drive_file_id);
        fileHandled = 'moved_to_rejected';
      }
    } catch (e) {
      fileHandled = 'deferred';
    }
  }

  return { ok: true, verdict, removed_from_campaign: removedFromCampaign, file: fileHandled };
}

/**
 * Removes rejected clippers' videos once their week is up, and clears the
 * id so the row stops claiming to have a file.
 *
 * Reads the rows rather than trusting reviewApplication to have moved every
 * file, so a Drive outage during a verdict self-heals on the next pass
 * instead of leaving a video in the founder's Drive indefinitely.
 */
export async function purgeExpiredRejections(db, env, { at = Date.now(), fetchImpl } = {}) {
  if (!env) return { purged: 0, failed: 0 };
  const opts = fetchImpl ? { fetchImpl } : undefined;
  const cutoff = at - DRIVE_REJECTED_RETENTION_MS;
  const { results } = await db.prepare(
    `SELECT id, drive_file_id FROM campaign_applications
      WHERE status = 'rejected' AND drive_file_id IS NOT NULL AND reviewed_at IS NOT NULL
        AND reviewed_at < ?
      LIMIT 200`
  ).bind(cutoff).all();

  let purged = 0, failed = 0;
  for (const row of results || []) {
    try {
      await deleteFile(env, row.drive_file_id, opts);
      // Cleared only after Drive confirms, so a failure here leaves the row
      // eligible for the next sweep rather than orphaning the file silently.
      await db.prepare('UPDATE campaign_applications SET drive_file_id = NULL WHERE id = ?')
        .bind(row.id).run();
      purged++;
    } catch {
      failed++;
    }
  }
  return { purged, failed };
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

/**
 * Lets everyone already past step 1 in the OLD flow carry on untouched. Run once,
 * when the review went live, and safe to run again: a participation that already has any
 * application row is skipped, so a real review is never overwritten.
 *
 * Two groups get an approval, matching how far they had actually got:
 *   - an account is connected to the participation: fully through, carry on;
 *   - no account yet, but the admin already approved their access request
 *     ('confirmed'): they are waiting at step 2, so they land at step 2.
 * Everyone else -- joined only, or a request still waiting on the admin -- has
 * nothing vetted yet and starts at step 1, like a new clipper. That includes
 * a request still 'requested' or the legacy 'invited': it had not been
 * approved, so it is not treated as if it had.
 *
 * Per participation, not per clipper: approved on campaign A says nothing
 * about campaign B, since the review is about fit with one campaign's style.
 */
export async function grandfatherExisting(db) {
  const res = await db.prepare(
    `INSERT INTO campaign_applications
       (clipper_id, campaign_id, video_url, attempt, status,
        reviewer_type, reviewer_name, reviewer_note, reviewed_at, created_at)
     SELECT p.clipper_id, p.campaign_id, NULL, 0, 'approved', 'system', 'System',
            CASE WHEN EXISTS (SELECT 1 FROM participation_accounts pa WHERE pa.participation_id = p.id)
                 THEN 'Already connected an account to this campaign before video review existed -- carried over automatically.'
                 ELSE 'Access request was already approved before video review existed -- carried over to the connect step.'
            END,
            ?, ?
       FROM participations p
      WHERE p.status != 'kicked'
        AND NOT EXISTS (SELECT 1 FROM campaign_applications a
                         WHERE a.clipper_id = p.clipper_id AND a.campaign_id = p.campaign_id)
        AND ( EXISTS (SELECT 1 FROM participation_accounts pa WHERE pa.participation_id = p.id)
           OR EXISTS (SELECT 1 FROM tester_requests t
                       WHERE t.clipper_id = p.clipper_id AND t.campaign_id = p.campaign_id
                         AND t.status = 'confirmed') )`
  ).bind(now(), now()).run();
  return { carried_over: (res.meta && res.meta.changes) || 0 };
}

/* ---------------------------------------------------------------- admin audit
 *
 * The admin's view of Step 1: every verdict, and who gave it. A moderator's
 * approval is a promise that the person is a good fit, so the admin needs to
 * see it next to what happened afterwards -- which is what `later_removed`
 * counts: approvals whose clipper was later kicked from that campaign or whose
 * account is no longer active. It is read from the rows as they are now, not
 * stored, so it cannot drift from what actually happened.
 *
 * Carried-over approvals (reviewer_type = 'system') are left out of both: nobody
 * reviewed those, so they say nothing about any moderator.
 */

// Shared so the scorecard and the log can never disagree on what counts.
const REMOVED_SQL = `(
    EXISTS (SELECT 1 FROM participations p
             WHERE p.clipper_id = a.clipper_id AND p.campaign_id = a.campaign_id AND p.status = 'kicked')
    OR EXISTS (SELECT 1 FROM clippers c WHERE c.id = a.clipper_id AND c.status != 'active')
  )`;

export async function reviewerScorecard(db) {
  const { results } = await db.prepare(
    `SELECT a.reviewer_type, a.reviewer_id, MAX(a.reviewer_name) AS reviewer_name,
            SUM(CASE WHEN a.status = 'approved' THEN 1 ELSE 0 END) AS approved,
            SUM(CASE WHEN a.status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
            SUM(CASE WHEN a.status = 'approved' AND ${REMOVED_SQL} THEN 1 ELSE 0 END) AS later_removed,
            MAX(a.reviewed_at) AS last_at
       FROM campaign_applications a
      WHERE a.status IN ('approved', 'rejected') AND COALESCE(a.reviewer_type, '') != 'system'
      GROUP BY a.reviewer_type, a.reviewer_id
      ORDER BY last_at DESC`
  ).all();
  const carried = await db.prepare(
    "SELECT COUNT(*) AS n FROM campaign_applications WHERE reviewer_type = 'system'"
  ).first();
  return { reviewers: results || [], carried_over: (carried && carried.n) || 0 };
}

/**
 * One page of verdicts, newest first. `reviewer` is 'type:id' (e.g. 'moderator:3'),
 * the same key the scorecard groups on, so a click on a scorecard row filters here.
 */
export async function reviewLog(db, { status = 'all', reviewer = '', campaignId = null, limit = 50, offset = 0 } = {}) {
  const where = ["COALESCE(a.reviewer_type, '') != 'system'"];
  const bind = [];
  if (status === 'approved' || status === 'rejected' || status === 'pending') {
    where.push('a.status = ?'); bind.push(status);
  }
  const m = /^(moderator|admin):(\d*)$/.exec(String(reviewer || ''));
  if (m) {
    where.push('a.reviewer_type = ?'); bind.push(m[1]);
    if (m[2]) { where.push('a.reviewer_id = ?'); bind.push(Number(m[2])); }
    else where.push('a.reviewer_id IS NULL');
  }
  if (campaignId) { where.push('a.campaign_id = ?'); bind.push(Number(campaignId)); }

  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const { results } = await db.prepare(
    `SELECT a.id, a.clipper_id, a.campaign_id, a.attempt, a.status,
            a.reviewer_type, a.reviewer_id, a.reviewer_name, a.reviewer_note,
            a.reviewed_at, a.created_at,
            COALESCE(cl.display_name, cl.username) AS clipper_name, cl.status AS clipper_status,
            ca.name AS campaign_name,
            p.status AS participation_status,
            CASE WHEN EXISTS (SELECT 1 FROM participation_accounts pa WHERE pa.participation_id = p.id)
                 THEN 1 ELSE 0 END AS connected,
            CASE WHEN a.status = 'approved' AND ${REMOVED_SQL} THEN 1 ELSE 0 END AS later_removed
       FROM campaign_applications a
       JOIN clippers cl ON cl.id = a.clipper_id
       JOIN campaigns ca ON ca.id = a.campaign_id
       LEFT JOIN participations p ON p.clipper_id = a.clipper_id AND p.campaign_id = a.campaign_id
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(a.reviewed_at, a.created_at) DESC, a.id DESC
      LIMIT ? OFFSET ?`
  ).bind(...bind, lim, off).all();
  return results || [];
}
