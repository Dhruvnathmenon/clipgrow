// The earning formula existed in two places: allocateCampaignEarnings computed
// it to WRITE a clip's value, and payableClips computed it again to DISPLAY
// that value. payouts.js said so in a comment -- "if these two drift, the
// amount shown to the admin stops matching the amount the clip is actually
// locked at" -- and nothing tested it. They are now one function.
//
// The second half of this file covers what nothing could previously answer:
// WHY a clip is worth what it is. The allocator applies the per-video cap and
// then the remaining-budget clamp and leaves no trace of which one bit, so a
// clip reduced because the campaign ran out of money looked identical to one
// that simply had fewer views -- to the admin and to the clipper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpmEarning, explainEarning, explainEarningText } from '../src/earning-math.js';

/* ─────────────────────── the rounding rule ─────────────────────── */

test('multiplies before dividing, so the creator is not short-changed', () => {
  // The exact case the source comment cites: at cpm 25, 1160 views must give
  // 29, not the 28 that (views / 1000) * cpm produces via binary fraction.
  assert.equal(cpmEarning(1160, 25), 29);
  assert.equal(Math.floor((1160 / 1000) * 25), 28, 'the wrong order really does differ');
});

test('the underpay-by-one error does not reappear across the real range', () => {
  // The comment claims 6182 view counts are affected across cpm 10..333 and
  // views 0..500k, and that the error is one-directional. Spot-check that the
  // shared function is never BELOW the exact value, at any cpm.
  for (const cpm of [10, 25, 30, 40, 50, 70, 333]) {
    for (let views = 0; views <= 20000; views += 137) {
      const exact = Math.floor((views * cpm) / 1000);
      assert.equal(cpmEarning(views, cpm), exact, `cpm ${cpm}, views ${views}`);
    }
  }
});

test('handles zero and missing inputs without producing NaN', () => {
  assert.equal(cpmEarning(0, 40), 0);
  assert.equal(cpmEarning(5000, 0), 0);
  assert.equal(cpmEarning(null, null), 0);
  assert.equal(cpmEarning(undefined, 40), 0);
});

/* ─────────────────────── why a clip earned that ─────────────────────── */

// clipper_earning defaults to match earning (no margin gap) so existing
// scenarios below stay about their own concern; tests specifically about
// the clipper/billable split set both explicitly.
const clip = (o = {}) => ({ views: 10000, earning: 400, clipper_earning: o.earning ?? 400,
                            status: 'active', eligible: 1,
                            locked_at: null, locked_earning: null, lock_reason: null, ...o });

test('a plain CPM earning says so', () => {
  const x = explainEarning(clip(), { cpm: 40, minViews: 1000 });
  assert.equal(x.reason, 'cpm');
  assert.equal(x.full_earning, 400);
  assert.equal(x.amount, 400, 'no margin gap here -- 400 is already an exact multiple of cpm 40');
  assert.equal(x.next_milestone.amount, 440);
  assert.match(explainEarningText(x), /₹400 earned so far/);
});

test('amount is the clipper figure, never the billable one, when they genuinely differ', () => {
  // 10,000 views billed 400 (unchanged, exact cpm math), but this clip's
  // clipper_earning was floored to 360 (e.g. a max_per_video edge) -- amount
  // must report 360, with the billable figure still visible separately.
  const x = explainEarning(clip({ clipper_earning: 360 }), { cpm: 40, minViews: 1000 });
  assert.equal(x.amount, 360);
  assert.equal(x.billed_earning, 400);
  assert.match(explainEarningText(x), /₹360 earned so far/);
});

test('a clip under the minimum says how many views it still needs', () => {
  const x = explainEarning(clip({ views: 600, earning: 0 }), { cpm: 40, minViews: 1000 });
  assert.equal(x.reason, 'below_min');
  assert.equal(x.views_needed, 400);
  assert.match(explainEarningText(x), /400 more views/);

  const one = explainEarning(clip({ views: 999, earning: 0 }), { cpm: 40, minViews: 1000 });
  assert.match(explainEarningText(one), /1 more view to start/, 'singular, not "1 more views"');
});

test('a clip stopped by the per-video cap says which cap, and pays the CPM floor of it', () => {
  // 10,000 views at 40 = 400, capped at 250. The clipper is then paid the CPM
  // floor of that capped 250 -- floor(250/40)*40 = 240, margin 10.
  const x = explainEarning(clip({ earning: 250, clipper_earning: 240 }), { cpm: 40, minViews: 1000, maxPerVideo: 250 });
  assert.equal(x.reason, 'capped');
  assert.equal(x.full_earning, 400);
  assert.equal(x.capped_earning, 250);
  assert.equal(x.billed_earning, 250);
  assert.equal(x.amount, 240, 'paid the CPM floor of the capped billable amount, not the cap itself');
  assert.match(explainEarningText(x), /₹240 earned.*maximum of ₹250 per video/);
});

test('a clip clamped by the campaign budget is distinguishable from a small clip', () => {
  // This is the gap that existed: 400 earned nothing but 90 because the budget
  // ran dry, and the clip looked exactly like one with a quarter of the views.
  // The clipper is then paid the CPM floor of that 90 -- floor(90/40)*40 = 80.
  const x = explainEarning(clip({ earning: 90, clipper_earning: 80 }), { cpm: 40, minViews: 1000 });
  assert.equal(x.reason, 'budget');
  assert.equal(x.full_earning, 400);
  assert.equal(x.billed_earning, 90);
  assert.equal(x.amount, 80);
  assert.match(explainEarningText(x), /₹80 earned so far/);
});

test('the cap is checked before the budget, matching the allocator order', () => {
  // Capped to 250, then the budget only allowed 90. The binding constraint the
  // clipper needs told about is the budget, not the cap.
  const x = explainEarning(clip({ earning: 90, clipper_earning: 80 }), { cpm: 40, minViews: 1000, maxPerVideo: 250 });
  assert.equal(x.reason, 'budget');
  assert.equal(x.capped_earning, 250);
});

test('a settled clip reports the frozen amount, not the live one', () => {
  const x = explainEarning(
    clip({ earning: 999, locked_at: 1, locked_earning: 400, lock_reason: 'paid' }),
    { cpm: 40, minViews: 1000 });
  assert.equal(x.reason, 'paid');
  assert.equal(x.amount, 400, 'locked_earning is authoritative once locked');
  assert.match(explainEarningText(x), /will not change/);
});

test('a written-off clip reads as closed, not as a failure', () => {
  const x = explainEarning(
    clip({ views: 300, earning: 0, locked_at: 1, locked_earning: 0, lock_reason: 'below_min' }),
    { cpm: 40, minViews: 1000 });
  assert.equal(x.reason, 'closed');
  assert.match(explainEarningText(x), /Closed at ₹0/);
});

test('ineligible and non-active clips are named, not left blank', () => {
  assert.equal(explainEarning(clip({ eligible: 0 }), { cpm: 40 }).reason, 'ineligible');
  assert.equal(explainEarning(clip({ status: 'paused' }), { cpm: 40 }).reason, 'paused');
  assert.equal(explainEarning(clip({ status: 'disqualified' }), { cpm: 40 }).reason, 'disqualified');
});

test('every reason produces a sentence, never an empty string', () => {
  const cases = [
    clip(),
    clip({ views: 100, earning: 0 }),
    clip({ earning: 250 }),
    clip({ earning: 90 }),
    clip({ eligible: 0 }),
    clip({ status: 'paused' }),
    clip({ status: 'disqualified' }),
    clip({ locked_at: 1, locked_earning: 400, lock_reason: 'paid' }),
    clip({ locked_at: 1, locked_earning: 0, lock_reason: 'below_min' })
  ];
  for (const c of cases) {
    const text = explainEarningText(explainEarning(c, { cpm: 40, minViews: 1000, maxPerVideo: 250 }));
    assert.ok(text && text.length > 10, `empty explanation for ${JSON.stringify(c)}`);
  }
});
