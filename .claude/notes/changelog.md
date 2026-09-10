# Changelog — condensed history

High-level, dated. For exact detail read the actual commit
(`git show <hash>`) rather than trusting this summary as complete — this
exists to answer "have we already done X" quickly, not to replace git log.

## 2026-09-10
- **Instagram tokens now auto-renew — no more reconnect waves.** IG long-lived
  tokens last 60 days but can be extended another 60 while still valid
  (`graph.instagram.com/refresh_access_token`, already wired as
  `ig.refreshLongLivedToken` — just never called). New `src/token-renewal.js`
  `renewInstagramTokens()` runs on the cron: renews the ≤5 tokens closest to
  expiry each pass (12-day window), so every connection refreshes ~every 48
  days and never nears the wall. A token that genuinely can't be saved (clipper
  revoked it in their IG settings, or it already lapsed) → `needs_reauth`,
  which is now the ONLY reconnect case. Manual `POST /api/admin/instagram/
  renew-tokens` (30-day window, cap 40) + a button on the Sync Health tab for
  a one-off catch-up. Cannot rescue an already-expired token — the 2 current
  `needs_reauth` accounts still need their clippers to reconnect once.
- **Refresh chaining audit + SUBREQUEST_LIMIT fix.** Jobs 160-171 all
  completed cleanly (3-4 invocations, 0 skipped) — the chaining is healthy.
  One real bug: when a run hit Cloudflare's per-invocation subrequest cap, the
  IG adapter returned `{ok:false, code:'SUBREQUEST_LIMIT'}` per clip and
  `runViews` stamped that as a real `sync_error`, making "we didn't reach it
  this pass" look like breakage. Now `runViews` returns `budgetHit` and
  `runChunk` re-queues the item untouched (no sync_error, no failure count)
  and hands off — which is what the chain is for. Same for a thrown
  SUBREQUEST_LIMIT (YT batch / token refresh). Deploy cleared the 2 stale rows.
- **Sync Health tab** (`GET /api/admin/sync-health`): every active clip inside
  its 7-day window whose views aren't moving, grouped by reason (removed /
  no-insights / reconnect / disconnected / transient / awaiting-first-sync),
  each tagged **you fix this** / **clipper fixes this** / **clears itself**,
  with a WhatsApp/Discord button (clipper's job) or a Flag-invalid button
  (yours). Reconnect reality: only 2 accounts currently need it; Instagram's
  60-day token life means a small recurring wave is normal.
- **Error runbook now names who acts.** Each entry + each inline hint carries a
  coloured "the clipper fixes this / you fix this / clears itself / send to
  Claude" tag. Added MEDIA_NOT_FOUND, PRE_CONVERSION_MEDIA, SUBREQUEST_LIMIT.
- **Perf: killed the N+1 on the clipper rosters.** `/api/admin/clippers` was
  ~6 D1 queries PER clipper in a sequential loop (financials x2, accounts,
  participations, recency, quality); `/api/moderator/clippers` ~3 per row.
  Past a few dozen clippers this was seconds of latency and enough to trip
  D1's per-request statement ceiling (the intermittent "D1_ERROR: internal
  error" on those endpoints). New `allClipperFinancials()` / `allClipperQuality()`
  batch helpers (mirrors `allClipperStreaks`) — both endpoints are now a fixed
  ~6 / ~3 queries regardless of roster size. `test/roster-batch-aggregates`
  pins the batch output byte-identical to the per-clipper functions.
- Fixed `Cannot read properties of null (reading 'campaigns')` on
  `DELETE /api/admin/accounts/:id` — a double-click / two-tab race where
  `disconnectSocialAccount` returns null the second time.
- **Error Log tab**: a "Common errors & how to fix them yourself" reference
  card (collapsible, always there), plus an inline **Fix:** line on any logged
  row whose message matches a known pattern (expired connect link, reused auth
  code, transient D1 error, token/reconnect, slow page, account-in-use).
- **Flag Video tab**: paste an Instagram/YouTube link + reason → the matching
  tracked clip is invalidated immediately (same path as the clipper-page
  button). `POST /api/admin/submissions/invalidate-by-url`, matches by the
  video's own id (IG shortcode / YT video id) pulled from the link against the
  stored `permalink`, tolerant of `?igsh=`, `youtu.be`, `watch?v=` etc. Shared
  `invalidateSubmissionRow()` helper now backs both the by-id and by-URL routes.
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
