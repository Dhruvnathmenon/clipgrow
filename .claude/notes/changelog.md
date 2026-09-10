# Changelog — condensed history

High-level, dated. For exact detail read the actual commit
(`git show <hash>`) rather than trusting this summary as complete — this
exists to answer "have we already done X" quickly, not to replace git log.

## 2026-09-10
- **Manual clip invalidation** (`migration 040`): admin flags a clip invalid
  with a required typed reason — reuses the `disqualified` status (already
  zeroes earning + releases budget FCFS), adds `invalidated_at/by/reason`,
  an audit-log entry, and holds through anything the clipper does (reconnect
  / re-import already dedupe on media id). `POST .../invalidate` +
  `POST .../revalidate` (revalidate does a best-effort live view re-fetch
  then re-prices). `disqualified` removed from the plain status PATCH.
  Buttons added to the clipper-detail Videos table (was campaign-only).
- **Client-raised clip flags**: the client portal's one write — a brand
  reports a clip on their own campaign (`POST /api/client/campaigns/:id/
  clips/:clipId/flag`), which raises an alert on the admin Overview banner.
  Resolved from the clipper page (invalidate auto-closes the flag) or
  dismissed as a false alarm. Everything else in the client portal stays
  read-only.
- **Fixed client-dashboard leak**: `/api/client/campaigns/:id` had no status
  filter, so a `disqualified` clip still showed to the brand with its views
  counted. Now `status = 'active'` only.
- **Kick now releases unpaid earnings**: kicking a clipper from a campaign
  drops their unlocked clips to ₹0 and frees the budget back to the pool
  (was: freeze at accrued value, keep consuming budget). Paid clips
  untouched. `frozen_earning` still stamped as a dispute record, no longer
  read by the allocator. Use Pause for an amicable stop that keeps the money.
- **Disconnect simplified**: removed "Reset for New Account" — one Disconnect
  action that unlinks, deletes unpaid clips, frees their budget, keeps
  settled history, and leaves the access approval intact so the clipper can
  reconnect and re-link themselves.

## 2026-08-27
- Removed the clipper-triggered full refresh entirely; cron + per-clip
  refresh only now. Verified the cron was already healthy first rather
  than assuming it was broken. (`09922fa`)
- Fixed Instagram's permanent "posted before Business conversion" error
  being misclassified as a fixable permission problem. (`1b067a0`)

## 2026-08-26
- Admin health banner now names the specific broken account instead of
  showing a bare count. (`6a69c48`)
- YouTube access-request flow changed from "enter Google email, admin
  allowlists in Cloud Console" to "enter channel handle, admin reviews and
  approves" — Cloud Console step removed entirely. (`bdd8bae`)
- One-time forced YouTube reconnect flow built and rolled out, after
  moving the Google OAuth consent screen from Testing to Production status
  to kill the 7-day refresh-token expiry Testing imposes. (`2e13e1c`)
- Clipper-facing UI for a dead connection, explaining reconnecting is safe.
  (`5de3ab1`)

## 2026-08-24
- Fixed `disconnect` throwing a foreign-key error for any account that had
  ever synced. (`6ac534b`)
- Fixed 7 defects found by an adversarial review of the previous day's own
  work (payout math, write-off sweep, rollback safety). (`787d611`)
- **Restored auto-import**, which had silently created zero new clips for
  ~28 hours — a refactor made it count fetched videos without ever
  inserting them. (`007ab03`)
- Added "checked N ago" freshness label to clip cards; enabled per-clip
  refresh for YouTube (previously Instagram-only). (`27c8dea`)
- Removed two decorative, unenforced payout fields (`min_payout`,
  `max_payout_per_channel`); fixed kicked-clipper earnings ratcheting down
  permanently on a budget cut; added payment `kind`
  (settlement/advance/bonus) with advance-recovery tracking. (`2cf0c7e`)
- Admin panel now shows every linked account (was Instagram-only due to a
  legacy-column bug). (`32f0f1a`)
- Fixed 7 defects found by auditing the frontend/backend API contract and
  payout math directly. (`528f276`)
- Added the static-verification test suite: real-schema SQL validation,
  module-integrity (dangling imports), page-functions (deleted JS
  functions still called from HTML). (`2061ac6`, `bf75fdc`)
- Restored 3 UI functions whose deletion had silently broken every refresh
  button. (`b9a0bf5`)
- Fixed Connected Accounts falsely showing YouTube as unlinked, and a
  doubled `@@` handle display bug. (`4e3e074`)

## 2026-08-23
- Added Privacy Policy, Terms of Service, Data Deletion pages
  (`privacy.html`, `terms.html`, `data-deletion.html`). (`c23cf8f`)
- Trimmed unused Instagram OAuth scopes; disconnect now actually revokes
  the Google token server-side, not just locally. (`89770f0`)
- Built and shipped the full chained-refresh job engine (Phases 0–6),
  replacing the old flat sync — the reason for most of the following
  week's bug-fix commits, per the retrospective in `09922fa`.
  (`eed0ec6`, `ef517a0`, `eb0f2b1`, `d2d8531`, `58034be`, `6e13d9c`)

## Earlier
- 2026-08-22: per-account paste-only tracking for clippers posting from a
  main account also used personally. (`1518a07`)
- 2026-08-21: posting streaks + last-post recency on the clipper
  leaderboard. (`71742b1`)
- 2026-08-20: stopped YouTube auto-import silently dying and re-probing
  the whole channel every run. (`2733bc5`)
- 2026-08-19: fixed a false "stuck 12+ hours" alert firing on a clip's
  first sync attempt. (`973b7e8`)
- 2026-08-16: allowed deleting a locked clip that was never actually paid.
  (`e5ddb61`)
