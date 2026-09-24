// What every refresh job runs alongside its legs, defined once.
//
// It used to be written out five times (the hourly cron, the queue consumer,
// and three admin buttons), each as "re-price everything when the job finishes".
// A job that never finished -- and for 14 hourly runs in a row on 24 Sep 2026
// none did -- therefore priced nothing, so a clip that had just arrived stayed
// at Rs 0 while its views climbed, under a message claiming the campaign's budget
// had run out. Pricing is now tied to the thing that changes it (views), not to
// the job's last step:
//
//   afterChunk  after EVERY leg. Pure D1 work, idempotent, cheap next to the
//               platform calls it follows, and safe to repeat.
//   onFinish    once, when the job's whole list is done. Only the informational
//               bot-score pass lives here: it reads two weeks of snapshots, which
//               is too heavy to repeat every leg and changes no money.
import { reallocateAll } from './earnings.js';
import { scoreRecentSubmissions } from './bot-scoring.js';
import { logError } from './error-log.js';
import { SUBREQUEST_BUDGET } from './refresh-jobs.js';

/** Prices every open campaign; a failure goes to the Error Log, where the admin page badges it. */
export async function repriceAll(db, where) {
  try {
    await reallocateAll(db);
  } catch (e) {
    // Never allowed to stop the refresh it rides along with, but never silent either:
    // an unpriced campaign shows clippers numbers that no longer match their views.
    await logError(db, {
      actorType: 'system', source: 'pricing', code: 'REPRICE_FAILED',
      message: 'Some campaigns could not be re-priced, so earnings there may be behind the views.',
      detail: String(e && e.message), path: where || 'refresh'
    });
  }
}

const NEAR_LIMIT_QUIET_MS = 6 * 60 * 60 * 1000;

/**
 * A leg that had to stop early for room or time is the earliest warning there is that the
 * refresh is outgrowing its limits: harmless once, the start of another outage if it keeps
 * happening. Said once per six hours, not once per leg, so it stays readable.
 */
export async function noteNearLimit(db, r) {
  if (!r || !r.outOfRoom) return;
  try {
    const recent = await db.prepare('SELECT id FROM error_log WHERE code = ? AND created_at > ? LIMIT 1')
      .bind('REFRESH_NEAR_LIMIT', Date.now() - NEAR_LIMIT_QUIET_MS).first();
    if (recent) return;
    await logError(db, {
      actorType: 'system', source: 'refresh', code: 'REFRESH_NEAR_LIMIT',
      message: 'A view-refresh step stopped early to stay under the per-run limits Cloudflare sets. Nothing is lost: the rest continues in the next step.',
      detail: `It had used ${r.subrequests} of its ${SUBREQUEST_BUDGET} request budget when it stopped. If this appears every hour, the refresh is growing past what one run can do: raise limits.subrequests in wrangler.jsonc together with SUBREQUEST_BUDGET, or look at what each clip costs.`,
      path: 'refresh'
    });
  } catch { /* a warning about a warning is not worth failing the refresh over */ }
}

export function refreshHooks(db) {
  return {
    afterChunk: async (_jobId, r) => { await repriceAll(db, 'refresh'); await noteNearLimit(db, r); },
    onFinish: async () => { await scoreRecentSubmissions(db); }
  };
}
