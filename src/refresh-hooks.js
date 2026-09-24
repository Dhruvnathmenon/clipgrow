// What every refresh job runs alongside its legs, defined once.
//
// It used to be written out five times (the hourly cron, the queue consumer,
// and three admin buttons), each as "re-price everything when the job finishes".
// A job that never finished -- and for 13 hourly runs in a row on 24 Sep 2026
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

export function refreshHooks(db) {
  return {
    afterChunk: () => repriceAll(db, 'refresh'),
    onFinish: async () => { await scoreRecentSubmissions(db); }
  };
}
