// The one place that knows how a clip's earning is arrived at.
//
// This existed twice: allocateCampaignEarnings computed it to WRITE the value,
// and payableClips computed it again to DISPLAY the value. The comment in
// payouts.js said so explicitly -- "if these two drift, the amount shown to the
// admin stops matching the amount the clip is actually locked at" -- and
// nothing pinned them together. One shared function is the fix.
//
// It also answers "why did I earn this?", which nothing could. The allocator
// applies three separate reductions in order (per-video cap, then remaining
// budget) and left no trace of which one bit, so a clip clamped because the
// campaign ran out of money was indistinguishable from a clip that simply had
// fewer views -- to the admin and to the clipper. Deriving the reason on read
// avoids adding a column to the money table to store something the data
// already implies.

/**
 * Rupees earned by `views` at `cpm`, before any ceiling.
 *
 * Multiply BEFORE dividing. (views / 1000) * cpm goes through a binary
 * fraction that lands a hair under the true value and Math.floor then drops a
 * rupee: at cpm 25, 1160 views gives 28 instead of 29. Across cpm 10..333 and
 * views 0..500k there are 6182 such view counts, and the error is
 * one-directional -- it only ever underpays the creator.
 */
export function cpmEarning(views, cpm) {
  return Math.floor((Number(views || 0) * Number(cpm || 0)) / 1000);
}

/**
 * Why a clip is worth what it is worth.
 *
 * `amount` is the authoritative figure for the clip -- locked_earning once it
 * is locked, earning otherwise. Everything else is the arithmetic that
 * produced it, so a screen can show the working rather than a bare number.
 *
 * reason is one of:
 *   paid        settled and locked; this is history and will not move
 *   closed      locked at zero (a below-minimum write-off)
 *   ineligible  not an eligible format (e.g. a YouTube upload that is not a Short)
 *   paused      participation or clip paused
 *   disqualified
 *   below_min   has not reached the campaign's minimum view count yet
 *   capped      hit the campaign's maximum payout per video
 *   budget      the campaign's remaining budget ran out before this clip
 *   cpm         the plain views x cpm figure, nothing reduced it
 */
export function explainEarning(row, { cpm, minViews = 0, maxPerVideo = 0 } = {}) {
  const views = Number(row.views || 0);
  const locked = !!row.locked_at;
  const amount = locked ? Number(row.locked_earning || 0) : Number(row.earning || 0);

  const full = cpmEarning(views, cpm);
  const ceiling = maxPerVideo > 0 ? Math.min(full, maxPerVideo) : full;

  const base = {
    amount, views, cpm: Number(cpm || 0),
    min_views: Number(minViews || 0),
    max_per_video: Number(maxPerVideo || 0),
    full_earning: full,
    capped_earning: ceiling
  };

  if (locked) {
    return { ...base, reason: row.lock_reason === 'paid' ? 'paid' : 'closed' };
  }
  if (row.eligible === 0) return { ...base, reason: 'ineligible' };
  if (row.status && row.status !== 'active') return { ...base, reason: row.status };
  if (minViews > 0 && views < minViews) {
    return { ...base, reason: 'below_min', views_needed: Math.max(0, minViews - views) };
  }
  // The allocator applies the per-video cap first, then clamps to whatever
  // budget is left. Comparing against both tells us which one actually bit.
  if (amount < ceiling) return { ...base, reason: 'budget' };
  if (ceiling < full) return { ...base, reason: 'capped' };
  return { ...base, reason: 'cpm' };
}

const RS = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const NUM = (n) => Number(n || 0).toLocaleString('en-IN');

/** One plain sentence a clipper can read, from the same explanation. */
export function explainEarningText(x) {
  switch (x.reason) {
    case 'paid':
      return `Paid: ${RS(x.amount)}. Settled and closed — this figure will not change.`;
    case 'closed':
      return 'Closed at ₹0 — it never reached the campaign minimum before the payout run.';
    case 'ineligible':
      return 'This format does not earn on this campaign.';
    case 'paused':
      return 'Paused — it keeps tracking views but is not earning right now.';
    case 'disqualified':
      return 'Disqualified — it does not earn.';
    case 'below_min':
      return `${NUM(x.views_needed)} more view${x.views_needed === 1 ? '' : 's'} to start earning (minimum ${NUM(x.min_views)}).`;
    case 'capped':
      return `${NUM(x.views)} views at ${RS(x.cpm)} per 1,000 = ${RS(x.full_earning)}, ` +
             `capped at this campaign's maximum of ${RS(x.max_per_video)} per video.`;
    case 'budget':
      return `${NUM(x.views)} views at ${RS(x.cpm)} per 1,000 = ${RS(x.capped_earning)}, ` +
             `but the campaign budget ran out — this clip earned ${RS(x.amount)} of it.`;
    default:
      return `${NUM(x.views)} views at ${RS(x.cpm)} per 1,000 = ${RS(x.amount)}.`;
  }
}
