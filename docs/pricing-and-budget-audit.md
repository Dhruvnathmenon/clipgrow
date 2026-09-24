# Earnings stuck at ₹0, and an audit of everything that touches a campaign's money

Written 24 Sep 2026. Plain language first; the technical detail is further down for whoever
needs it.

---

## 1. The short version

**What you saw.** A clip on the Mali campaign had 10,797 views, showed ₹0, and said *"the
campaign budget ran out"*.

**What was actually true.** The budget had not run out. Mali had about ₹3,900 free. The clip
was simply never priced.

**Why it was never priced.** A clip's earning is worked out from its views and the campaign
budget, and stored. The program that does this work was only run at the very end of the hourly
view refresh. From 03:00 UTC that refresh was being killed part-way through, every hour, so it
never reached its end, so nothing was priced. The clip you saw had arrived at 10:03 UTC, during
that stretch, and was never priced at all.

**Why the message was wrong.** The dashboard decided "budget ran out" whenever a clip earned
less than views × CPM. It never checked whether the campaign really had budget left. A clip that
is merely behind looks the same, so it guessed, and guessed wrong.

**Nobody lost money to this.** I checked all 458 paid clips. Every one was paid exactly what
its views were worth (views × CPM, capped). None was locked low or high.

**What is fixed and live** (deployed 24 Sep, version `f0afdabe`, checkpoint `23-pricing-survives`):

1. The refresh is no longer killed. The limit that was killing it is raised, and the refresh now
   counts its own requests and stops early, with room left to finish properly.
2. Prices now follow views. They are recomputed after every step of the refresh and again at the
   start of every hourly run, instead of only when the whole job finished.
3. The "budget ran out" sentence is only said when it is true. Otherwise the clip says its earning
   is still being added up.
4. Paying a clip now re-prices it first, so a stale figure can never be locked in permanently.
5. Creating and editing a campaign refuses the slips that used to be accepted quietly (section 4).
6. A dead refresh job and a pricing failure now show up in the admin Error Log. Before, nothing
   showed anywhere: it ran broken for 14 hours without a sign.
7. The Mali clip is corrected now (₹0 → ₹543), and Mali matches the allocator exactly.

**Two things need your decision** (section 6): payouts since 6 Sep are not recorded in the wallet
ledger (₹51,505 across 30 payments), and a rule about who gets budget when it is freed.

---

## 2. What happened, with the real numbers

| When (UTC) | What |
|---|---|
| Up to 20 Sep | Refresh jobs mostly finished. Big ones carried on through the queue in several steps, and that worked. |
| 19–23 Sep | Runs started failing ("abandoned after 30 minutes") as the number of clips grew: 8 of 16 on the 19th, 6 of 23 on the 20th, none on the 21st, 4 of 24 on the 22nd, 13 of 24 on the 23rd. It was the bigger runs that failed; runs under roughly 125 clips finished. This fits the same limit, but I only proved the cause for the runs of 24 Sep. |
| 24 Sep, 03:00 to 16:00 | **Every** run failed: 14 in a row. |
| 24 Sep, 10:03 | The Mali clip is imported. It is never priced. |
| 24 Sep, 17:01 | I watched the live production log through the next run. It ended with the error **"Too many API requests by single Worker invocation"** after 5.7 minutes, using only 0.6 seconds of processor time. |

That last line is the proof. It rules out a slow computer (0.6 s of processor) and points at
Cloudflare's per-run request limit, which `wrangler.jsonc` had pinned at 1,000.

**Why 1,000 was too few.** The code assumed only calls out to Instagram and YouTube count toward
that limit. Cloudflare counts every database query too. Measured on the real code with a
realistically sized job: a run over 84 accounts and about 170 clips costs roughly 1,100 database
queries plus 168 platform calls, so about 1,270 requests. A run of around 125 clips or more crosses
1,000. That matches where the jobs split into "done" (113 to 124 clips) and "failed" (128 clips and up)
before 03:00.

**What a killed run left behind.**
- New clips were not priced, and the message on them was wrong.
- The next step of the job was never queued, so clips belonging to accounts near the end of the list
  were refreshed less often than hourly, and their new uploads were discovered late.
- The bot-risk scores were not recomputed (they only ran at the end too). Those are informational.
- The record of Instagram calls used was not saved for the killed runs.

---

## 3. What changed

| Where | Change |
|---|---|
| `wrangler.jsonc` | `limits.subrequests` 1,000 → 10,000, with the reason written beside it. |
| `src/d1-usage.js` | The database wrapper now counts every query. |
| `src/refresh-jobs.js` | The refresh stops at `SUBREQUEST_BUDGET` (8,000) with room to finish, hand off and price. Reports how many requests it used. A test ties this number to the pinned limit. |
| `src/refresh-hooks.js` (new) | One shared definition of "what runs with a refresh", used by the hourly run, the queue, and the three admin buttons. Prices after every leg. |
| `src/worker.js` | Prices at the start of every hourly run. Writes `JOB_ABANDONED` to the Error Log when a job dies. |
| `src/earnings.js` | Each campaign is priced on its own; one failure no longer leaves the rest unpriced. |
| `src/earning-math.js`, `src/db.js`, `src/routes/clipper.js`, `src/payouts.js` | The explanation sentence is told the campaign's remaining budget, and only claims "ran out" when it is true. |
| `src/payouts.js` | Paying re-prices first. |
| `src/routes/admin.js`, `admin.html` | Campaign create/edit guards, and the edit now tells you what it did to unpaid earnings. |
| `scripts/pricing-drift.mjs` (new) | A read-only check of whether production is priced the way the allocator would price it right now. |

Tests: 817 pass (was 804). The important one, `test/refresh-pricing-survives.test.mjs`, gives the
real refresh a database that enforces a request ceiling like Cloudflare's. Its first test
reproduces the incident: without the guard the job is cut off, queues nothing and prices nothing.
The next ones show the guard prevents it. Another reproduces the Mali case.

---

## 4. Everything I looked at, and what I found

Legend: **Fixed** = changed and tested. **Decision** = your call, see section 6. **Noted** = works
as designed, but worth knowing.

### Refresh and tracking

| Case | Finding | Status |
|---|---|---|
| Refresh run killed by the request limit | The incident above. | Fixed |
| A run that dies for any other reason | It was silent. The job just showed "failed" and nothing else moved. | Fixed: Error Log entry `JOB_ABANDONED` |
| Prices only computed when a whole job finishes | The root of the visible symptom. | Fixed |
| One campaign failing to price | Would have left every campaign after it unpriced. | Fixed |
| Bot scores only computed at job end | Stale during the outage. Informational only, changes no money. | Noted |
| New uploads at the end of the work list | They wait behind every clip refresh, so a big list discovers them late. | Noted (fixed indirectly: lists now finish) |
| First-come-first-served order uses the moment a clip **reached ClipGrow**, not when it was posted | A late discovery costs a clip its place in line. Fair in normal running, worse when discovery is delayed. | Decision |
| Tracking window is 7 days from ClipGrow's pickup | Sensible. A clip priced after its window closes keeps that price. | Noted |
| Two pricing passes at the same moment (an admin click and an hourly leg) | Last writer wins, and the next pass repairs it. Cannot exceed the budget for more than one pass. | Noted |

### Creating a campaign

| Case | Before | Now |
|---|---|---|
| CPM or budget typed as `1e999` | Accepted as infinity, poisoning every sum. | Refused |
| Per-video cap typed as `2,000` (with a comma), `-5`, or `abc` | Read as "no cap". The campaign paid uncapped, with no warning. | Refused, with a message |
| Minimum views typed but unusable | Silently replaced by the default of 1,000. | Refused |
| Cap left empty | No cap. | Unchanged, on purpose |

### Editing a campaign

| Case | Before | Now |
|---|---|---|
| CPM set to 0 | Accepted. Every unpaid clip in the campaign dropped to ₹0 at once. | Refused. To stop a campaign earning, mark it over. |
| Budget set to 0, or a typo like `abc` | 0 accepted; `abc` quietly ignored, with "Campaign updated". | Refused |
| Budget set below what has already been paid out | Accepted. Every unpaid clip priced at ₹0. | Refused, and says how much is already paid |
| Cap typed with a comma | Removed the cap and re-priced everything without it. | Refused |
| Status set by hand | Not reconciled with the budget until some later refresh finished. A campaign reopened with no budget left read "active". | Reconciled immediately |
| Any edit that moves earnings | Said only "Campaign updated". | Says how many unpaid clips moved and by how much, e.g. "121 unpaid clips re-priced: ₹2,765 → ₹1,840" |
| **Changing CPM** | Re-prices every **unpaid** clip on its full views, at once. Paid clips keep the rate they were paid at. | Noted, and now reported when you save |
| **Raising the minimum views** | Unpaid clips below it drop to ₹0. A later "close out below-minimum clips" can then lock them at ₹0 for good, including clips that were earning under the old rule. | Noted |
| **Lowering the minimum views** | Clips already closed at ₹0 stay closed, because closed is history like paid. | Fixed as far as visibility: the save now says how many closed clips would now qualify, so you can reopen them in Payouts |

### Budget arithmetic

| Case | Finding | Status |
|---|---|---|
| Budget reached, then flagged clips free some | The campaign correctly reopens, and clips are priced in arrival order. | Works. See decision 2 |
| A flagged clip is restored later | It takes its old place in line, ahead of newer clips, and can push them back to ₹0. | Decision |
| A clipper is disabled or archived | Their unpaid clips keep holding budget. Only **Kick** releases it, and Kick destroys their unpaid earnings. | Noted |
| A clip is deleted, or an account disconnected | Frees the budget and re-prices at once. | Works |
| Payment reversed | Clips return to unpaid and are re-priced at once. | Works |
| Top-up | Re-prices at once. Marked-over campaigns stay over. | Works |

### Payouts

| Case | Finding | Status |
|---|---|---|
| Paying a clip whose stored price lags its views | It would be locked, permanently, at the low figure. | Fixed: prices first. If the total differs from what your page showed, it refuses and asks you to reload. |
| Double click on Pay | Harmless: locked clips cannot be locked twice. | Works |
| Payout under ₹500 | Held back and rolls into the next run. | Works |
| Any historical underpayment from stale prices | Checked all 458 paid clips: none locked above or below views × CPM. | Clean |

### Finance

| Case | Finding | Status |
|---|---|---|
| **Payouts since 6 Sep are missing from the wallet ledger** | 30 of 38 settlements, ₹51,505. See section 6. | **Decision** |
| Advances and bonuses | They are recorded as payments only, never in the wallet ledger, so the wallet balance ignores money already sent. | Decision |
| Funding alerts | They skip campaigns marked **over**, so a client who still owes for delivered work stops appearing in the alert list. | Noted |
| A payment's amount edited through the API | Changes the payment but not its ledger entry. The screen has no edit button, only Reverse, so it cannot happen from the page. | Noted |

---

## 5. How to check things yourself

- **Is production priced right now?** `node scripts/pricing-drift.mjs` (read-only). Every campaign
  should say `OK`, or be off by a rupee or two from views moving since the last hourly run. Anything
  bigger that stays for more than an hour is worth a look.
- **Is the refresh healthy?** In the admin Error Log, look for `JOB_ABANDONED` (a run died) and
  `REPRICE_FAILED` (a campaign could not be priced). Neither should appear.
- **How close is a run to the limit?** The hourly log line reads
  `first chunk spent N platform calls and M subrequests in all`. M should stay a few thousand at
  most, against the 8,000 the run stops at and the 10,000 Cloudflare allows.

---

## 6. Decisions for you

### Decision 1: the wallet ledger is missing every payout since 6 Sep

Production has 38 settlement payments totalling ₹57,950. Only the first 8 (10 Aug to 2 Sep, ₹6,445)
have a wallet ledger entry. The next 30 (6 Sep to 20 Sep: ₹7,432, ₹3,679, ₹19,546 and ₹20,848)
have none, ₹51,505 in all.

**Cause I can see:** the Payouts "Pay & Lock" form does not send a wallet, so the payment is
recorded but the ledger is skipped. That form lost its wallet handling in the 5 Sep admin-page
change ("Finance tab reinstated"). Payouts from the next day on are the missing ones. This is the
evidence, not a proven cause, and I have not touched it.

**What it affects:** the "Clipper Payout Fund" wallet balance, the check that stops you sending money
you do not have, funding headroom per campaign, and the agency profit and cash figures. All of them
currently believe about ₹51,505 more is in the account than the ledger's own records support.

**What I recommend, in this order, only when you say so:**
1. Back-fill the 30 missing entries as one batch, marked as a back-fill so they can be told apart
   and voided together if any is wrong.
2. Make the payout always record a wallet (the agency payout fund by default), so money can never
   leave unrecorded again.
3. Add a "pay anyway" tick to the form. Once back-filled, the ledger says only about ₹1,050 is
   available (₹59,000 received less ₹57,950 paid), so the "you cannot send money you do not have" check
   would start refusing payouts until the next client payment is recorded. That check is correct, but
   without the tick you could not override it from the page.

I did not do this because it changes your accounting records and turns on a rule that will start to
refuse payouts. You should decide when.

### Decision 2: who gets budget when it is freed

When flagged clips free budget, it goes to whichever unpaid clips arrived first. A clip that is
restored later takes its old place in front of newer ones. That is the rule as built, and it is
consistent. The consequence is the surprise you hit: a campaign that reopens because budget was
freed can have less headroom than it looks like, since clips already inside their 7-day window keep
growing into it, and new clips may still end up at ₹0 legitimately. The message now says so
truthfully.

If you want a different rule, the options are: reserve a share for clips still growing before
reopening the campaign, or order by **post time** instead of the moment ClipGrow found the clip.
Neither is needed for this bug. To help you choose, this is what the difference is on Mali today:

- The typical clip is found **1.7 hours** after it was posted. One in ten waits more than 5.3 hours,
  and the slowest waited 10.8. 151 of the 347 automatically found clips waited over 2 hours. Part of
  that is the normal hourly rhythm, and part is the outage.
- Ordering by post time would put **395 of 462 clips in a different place** in line (121 of them by
  more than 10 places). It would only matter when the budget is nearly gone: Mali has about ₹3,900 free
  today, so nobody is short.
- I lean towards post time. It is the moment a clipper controls and can see, whereas the moment we find
  a clip depends on where their account happens to sit in the hourly list. The cost is that it changes
  who is funded in a tight campaign after the fact, so it should be announced, not slipped in.

---

## 7. What was verified

- 817 automated tests pass, including a test that fails if the request limit and the safety margin
  in the code drift apart.
- The cause was proved from a live production log, not inferred.
- Mali was corrected with the real allocator and re-checked: no clip is priced differently from what
  the allocator says now.
- Deployed in three small steps (the last is version `2747e7c8`), checkpoints 23 to 26.

### The first hourly run on the new code (18:01 UTC), watched live

| | Before (17:01 run) | After (18:01 run) |
|---|---|---|
| Outcome | `exception`: "Too many API requests by single Worker invocation" | **`ok`** |
| Wall time / processor time | 5.7 min / 0.6 s | 5.3 min / 0.66 s |
| Job | killed part-way, marked failed 1 hour later | **done in one pass**: 147 clips refreshed, 9 new clips imported, nothing left over |
| Requests used | over 1,000 (killed) | **2,117**, against 10,000 allowed and an 8,000 stop-early budget |
| Dead job from the hour before | left as "running" until reaped, silently | reaped, and written to the Error Log as `JOB_ABANDONED` (entry 151) |
| Pricing | not done | all 5 open campaigns match the allocator exactly (HeySchool, Clipgrow and Rishabh had small drifts an hour earlier, fixed by the run itself) |

One thing this run did not exercise: the hand-off to a second step. The whole job fitted in one step this
hour, so that path is verified by the tests (including the one that runs several steps under a ceiling), not
yet by a production run. It will be the first time it is used in production the next time a run has more than
200 platform calls of work.
