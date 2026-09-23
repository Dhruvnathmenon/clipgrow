# ClipGrow — read this first

This file is auto-loaded every session in this folder. It's short on
purpose — it points at the real reference material instead of repeating it,
so an ordinary prompt doesn't pay to load context it doesn't need.

## Read on demand, not automatically

- **`.claude/notes/project-context.md`** — what ClipGrow is, the
  architecture, the tooling that already exists. Read once at the start of
  a session that needs orientation; skip it for a narrow follow-up.
- **`.claude/notes/whats-next.md`** — open items, what's pending on the
  founder's side. Read when picking up work, not on every prompt.
- **`.claude/notes/common-mistakes.md`** — recurring bug classes and their
  fixes. Open **only** when something looks like a bug you might have
  already hit — don't preload it.
- **`.claude/notes/changelog.md`** — condensed, dated history. Open only
  when asked "have we done X" or for historical context.
- **`.claude/notes/seo.md`** — SEO strategy, audit findings, and the
  phased implementation plan. Read when the work is about search
  ranking, sitemap/robots, structured data, guides, or marketing-page
  crawlability.

## The one rule that always applies

Every write that can change a `submissions.earning` value or its lock
fields must carry `WHERE id = ? AND locked_at IS NULL`, and the caller
must check `meta.changes` before assuming it applied. A locked clip is
financial history — it must never be silently overwritten. See
`common-mistakes.md` for why this keeps coming up.

## Before deploying

`npm test` (schema-validated SQL, module integrity, page-function checks —
these catch real bug classes that have shipped before). Then
`npx wrangler deploy`.

## Deploying a change that touches the database

Apply the migration to production BEFORE `npx wrangler deploy`, never after.
New code that reads a column or table the live database does not have breaks
every request that touches it (this caused a day-long outage once). Check
first with a read-only query, e.g.
`npx wrangler d1 execute clipgrow --remote --json --command "SELECT name FROM pragma_table_info('campaigns')"`.

## Video review (campaign onboarding)

Always on -- there is no switch. A clipper must get a video approved on a
campaign before connecting an account to it (`src/applications.js`; enforced in
`canConnect` and the access-request route). Uploads go to the founder's Google
Drive through `src/drive.js`; if uploads fail, run **Check Google Drive** in the
admin Campaigns tab -- it reports exactly which link in the chain is broken.

## Discord connect (clipper identity)

A clipper links a verified Discord account through OAuth run inside their logged-in
session (`src/routes/discord-auth.js`); it never creates a session, so passwords stay
the only way in. How far it is switched on is `DISCORD_LINK` in `wrangler.jsonc`:
`off` -> `optional` -> `required`. Move up one step per deploy, and only after **Check
Discord** (admin Campaigns tab) is all green. The Discord secrets can exist while it is
`off`; never enforce on their presence alone.

## Account lifecycle and one account per person

`src/account-lifecycle.js` is the only place an account ends (admin archive, the clipper deleting
their own, and the daily unused-account clean-up all call `archiveClipper`). The clean-up only touches
accounts with no activity at all, only after a Discord warning has actually arrived, and never more than
25 per run; an account nobody can warn is listed in the admin Clippers tab, never removed. Email, phone
and Discord username are held unique on `email_key`/`phone_key`/`discord_key` (migration 051): any
statement that writes one of those three columns must write its key too (a test reads the source and
fails if one does not). Retries after a rejection wait 1h, 2h, 4h... up to a day (`src/backoff.js`).

## Self-serve sign-up

Anyone can create a clipper account only while `CLIPPER_SIGNUP` is `open` in `wrangler.jsonc`
(shipped `off`). The route is public and rate-limited (`src/signup.js`, table `signup_attempts`);
an account it makes can do nothing until its details are complete, Discord is linked (once
`required`) and a video is approved. Open it only after `DISCORD_LINK` is at least `optional`.
