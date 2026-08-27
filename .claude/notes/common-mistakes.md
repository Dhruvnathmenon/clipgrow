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
