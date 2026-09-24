# Common mistakes and their fixes

One entry per recurring bug class. When something breaks in a way that feels
familiar, check here before re-diagnosing from scratch. Add a new entry any
time the same root cause bites twice.

---

## `INSERT OR IGNORE` silently swallows constraint violations

**Symptom:** code reports success (`imported: 1`, a counter incremented) but
no row actually exists in the table.

**Cause:** `INSERT OR IGNORE` discards a row that violates a constraint
(NOT NULL, UNIQUE, FK) without raising an error. A join that's missing a
field you assumed was there (e.g. `campaign_id`) produces a row that's
silently dropped, and any code that increments a counter unconditionally
after the `.run()` call is lying about what happened.

**Fix:** always check `result.meta.changes` after an `INSERT OR IGNORE` /
`UPDATE ... WHERE ... AND locked_at IS NULL` before treating it as
successful. Real example: `src/refresh-jobs.js` `runImport` — auto-import
was broken for ~28 hours in production because of exactly this
(commit `007ab03`).

---

## The legacy `participations.account_id` column vs `participation_accounts`

**Symptom:** a query joining through `participations.account_id` returns
`null`/empty for an account that is definitely linked, but only for
non-Instagram platforms (YouTube).

**Cause:** `participations.account_id` is a legacy single-account column.
`linkParticipationAccount` (`src/db.js`) only keeps it in sync **for
Instagram**, for backward compatibility. The real, canonical source of
truth for every platform is the `participation_accounts` join table
(migration 012).

**Fix:** never join through `participations.account_id` for anything that
needs to work for YouTube. Always go through `participation_accounts`.
Bit this twice: once in the clipper dashboard's Connected Accounts page
(commit `4e3e074`), once in two admin queries (commit `32f0f1a`).

---

## `Number(x) || fallback` treats a deliberate `0` as "not provided"

**Symptom:** an admin sets a numeric field (budget, CPM) to `0` to
intentionally freeze something, gets a success toast, and the value is
silently unchanged.

**Cause:** `0 || fallback` evaluates to `fallback` in JS — this pattern
can't distinguish "the user typed 0" from "the user typed nothing."

**Fix:** use a helper like `numOr(value, fallback)` that checks
`value == null` explicitly rather than falsiness (see `src/routes/admin.js`).

---

## Every write to `submissions.earning`/lock fields needs `AND locked_at IS NULL`

**Symptom:** a paid/settled clip's earning or views change after it was
supposedly locked forever.

**Cause:** a locked clip is financial history — proof of what was actually
paid. Any write that doesn't re-check the lock at write time can race with
a payout happening between when a job's work-list was built and when the
write actually lands.

**Fix:** every `UPDATE submissions SET earning = ...` or
`SET views = ...` must carry `WHERE id = ? AND locked_at IS NULL`, and the
caller must check `meta.changes` to know if it actually applied. This is
the single most repeated invariant in the codebase's own comments — treat
it as non-negotiable, not a style preference.

---

## Error classification: don't bucket unknown API error codes into a misleading generic message

**Symptom:** an account/clip is told to "reconnect" or "check permissions"
for a condition that reconnecting can never fix, and it recurs forever
because the advice is wrong.

**Cause:** Instagram/Google Graph API errors often share a numeric `code`
across many different real causes, disambiguated only by `error_subcode`
or free-text `message`. A generic catch-all (e.g. `PERMISSION_MISSING` for
any unrecognized code-100 error) can silently absorb something entirely
different and permanent — e.g. `error_subcode: 2108006` means "this post
predates the account's Personal→Business conversion," which NO permission
grant or reconnect will ever fix (fixed in commit `1b067a0`,
`PRE_CONVERSION_MEDIA`).

**Fix:** when a health check or admin banner is about to tell a human to
take an action, verify that action can actually fix the specific error —
don't trust a generic bucket. Prefer matching on stable numeric
subcodes over free-text message matching when the API provides one. Before
trusting *any* claim like this, hit the real API directly with the stored
token to see the literal, current response rather than assuming.

---

## Shell escaping when patching files via `node -e` inline scripts

**Symptom:** a `node -e "..."` one-liner containing backticks, regex
literals, or embedded quotes gets mangled by the shell before Node ever
sees it — or a heredoc (`cat <<'EOF'`) with backslashes inside gets eaten.

**Fix:** for anything beyond a trivial one-liner, write the patch script to
a real `.cjs`/`.mjs` file with the `Write` tool first, then run it with
`node /path/to/script.cjs`. Also check whether the target file is CRLF or
LF (`grep -c $'\r' file` or similar) before doing string replacement —
mixing line-ending assumptions breaks `.includes()` matches silently.

---

## D1 MCP connector is unreliable — use the wrangler CLI directly

**Symptom:** `mcp__<cloudflare-id>__d1_database_query` calls start failing
or the tools disappear from availability mid-session.

**Fix:** for production D1 queries, use
`npx wrangler d1 execute clipgrow --remote --command "..."` via Bash
instead. It's slower per call but has been consistently reliable this
project, unlike the MCP connector.

---

## A semicolon inside a migration's `--` comment silently truncates the statement

**Symptom:** `test/sql-queries.test.mjs` (or any test using
`real-schema.mjs`) fails with `<file>.sql: incomplete input`, pointing at a
`CREATE TABLE` that looks completely fine.

**Cause:** `test/helpers/real-schema.mjs`'s `statements()` splits a
migration file into statements with a naive `.split(';')` after stripping
whole-line `--` comments — it does not understand that a `;` *inside* an
inline trailing comment (e.g. `col INTEGER, -- id where known; NULL if not`)
isn't a real statement terminator. The split happens right there, so the
back half of the `CREATE TABLE` becomes its own fragment and fails to parse
on its own.

**Fix:** never put a literal `;` inside a `--` comment in a migration file
— rephrase with a comma or an em dash, or move the comment to its own line
above the column instead of trailing it. (Real example: migration 038's
`error_log` table, caught immediately by this exact test before it ever
reached a real database.)

## A page whose script has one syntax error is completely dead, and says nothing

**Symptom:** a button does nothing. No message, nothing in the UI. (The admin login
was unclickable for a day.)

**Cause:** a newline typed inside a quoted string in ONE unrelated handler is a
syntax error, and a syntax error stops the whole inline script from running, so no
function on the page is ever defined. Almost always introduced by patching HTML
through a shell (`node -e`, heredocs, `sed`): backslashes and `\n` get eaten.

**Fix / guard:** patch with the Edit tool or a script file, never a shell one-liner.
`test/page-functions.test.mjs` now parses every inline script on every page, and
`components/error-net.js` (loaded first on every app page) shows a red banner when a
page throws or a request goes unhandled, so a break is visible instead of silent.

## Deleting a row while another row still points at it

**Symptom:** an admin "delete" returns a bare 500 ("FOREIGN KEY constraint failed").

**Cause:** D1 enforces foreign keys (`PRAGMA foreign_keys` = 1 in production). A
DELETE on a parent fails while any child row exists, and the test databases never
had children. In production 1,583 of 1,635 clips have a review row, so deleting a
clip failed for nearly all of them. It has happened three times (ig_api_calls,
submission_reviews, then submission_view_snapshots).

**Fix / guard:** clear the children in the same `db.batch` as the parent. Clips'
children are listed once in `SUBMISSION_CHILD_TABLES` (src/db.js); a test reads the
live schema and fails if a table is added that the list does not cover.
`test/delete-integrity.test.mjs` runs every delete against a database where every
table has a row.

## Input the code trusted to be the right type

**Symptom:** a 500 from a request only a broken client or a curious visitor sends.

**Causes, all found by `test/hostile-input.test.mjs`:** a JSON body of `null`
(`readJson` now always returns an object); ONE malformed cookie such as `x=%` on
the domain (`parseCookies` threw for every request that visitor made); garbage in
`?state=` (`verifySession` threw); `?limit=2.5` / `?offset=1e21` reaching SQL as a
non-integer (use `clampInt` from src/sql-utils.js for every paging value); an array
or object where an id belongs (the router maps D1's type error to a 400).

**Guard:** that test reads the routes out of the source, so a new route is attacked
automatically. Anything it reports is a real unhandled exception.

## Cloudflare counts every D1 query as a subrequest

**Symptom (24 Sep 2026):** a clip with 10,000+ views shown at Rs 0, telling its clipper
"the campaign budget ran out" while the campaign had thousands unallocated. Behind it, 13
hourly refresh jobs in a row were "Abandoned: no progress for over 30 minutes".

**Cause:** `wrangler.jsonc` pinned `limits.subrequests` at 1000 on the belief that only
`fetch()` calls count. Cloudflare's docs say otherwise: "a subrequest is any request a Worker
makes ... to Cloudflare services like R2, KV, or D1". A refresh chunk costs ~6 D1 queries per
clip plus the platform call, so ~170 clips is ~1,300 subrequests. The invocation was killed
mid-item (`Too many API requests by single Worker invocation`, CPU time 0.6 s of a 5.7-minute
run), before it wrote its final state, queued its next leg or priced a clip.

**How it was proved, not guessed:** `wrangler tail` through the next hourly run. The scheduled
event's outcome was `exception` with that message. A run that fits under the limit looks
"done"; the ones that do not look "failed", so the job table alternated done/failed for days
before it went to failed every hour.

**Fix / guard:** limit raised to 10,000; `wrapD1` counts every statement; `runChunk` stops at
`SUBREQUEST_BUDGET` (8,000) with room left to finish, hand off and price. A test ties the two
numbers together, and another runs the real runner against a database that enforces a ceiling
(`test/refresh-pricing-survives.test.mjs`, which includes a control that reproduces the death).
Any new per-item D1 work in a job makes a leg more expensive: measure with `r.subrequests`.

## A stored value that is only recomputed when a long job finishes

**Symptom:** the number on screen is wrong (a price, a status, a count) and stays wrong until
"something happens to run".

**Cause:** `submissions.earning` is a function of views and the campaign's budget, but it was
stored and recomputed only at the END of a refresh job (plus a list of admin actions). Anything
that stopped the job from finishing stopped every price in the system moving, and nothing said so.

**Fix / guard:** pricing follows the thing that changes it. `refreshHooks()` (src/refresh-hooks.js)
re-prices after EVERY leg and the cron re-prices at the start of every hourly run; `reallocateAll`
prices each campaign independently so one failure cannot freeze the rest; failures and abandoned jobs
go to the Error Log (`REPRICE_FAILED`, `JOB_ABANDONED`). Payout locking (`settlePayment`) prices
first, because locking freezes whatever is stored. `node scripts/pricing-drift.mjs` (read-only) says
whether production is priced the way the allocator would price it now.

When adding a stored derived value, list every event that changes its inputs, and give it a repair
path that does not depend on a long job finishing.

## An explanation that assumes a cause

**Symptom:** the app says WHY something is so, confidently, and is wrong ("the campaign budget
ran out").

**Cause:** `explainEarning` inferred "budget" from `amount < views x cpm`, but a price that is
merely behind its views looks identical. Deriving a reason from the outcome alone is a guess.

**Fix / guard:** it now takes the campaign's remaining budget (`budgetLeft`); with budget left,
or unknown, it says the price is being added up, and never claims the budget is gone.
