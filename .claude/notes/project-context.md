# What ClipGrow is, and how it's built

Read this for orientation at the start of a session. It answers "what is this
project and how does the code work" so that doesn't need re-explaining.

## The business

ClipGrow is a two-sided marketplace: brands ("Clients") fund campaigns,
creators ("Clippers") post short-form videos (Instagram Reels, YouTube
Shorts) promoting them and get paid per 1,000 verified views. Founder:
Dhruv. Co-founder: Spandan (equity undecided — see memory
`project-clipgrow-business-registration`).

Core payout rule: once a clip is paid, it's locked permanently at that
figure — later view growth never changes what it earned. A campaign sets a
minimum-views threshold (a clip below it earns nothing) and an optional
per-video payout cap. See `.claude/notes/common-mistakes.md` for the
`locked_at IS NULL` invariant this implies everywhere in the code.

## Architecture

- **Cloudflare Worker**, no build step, no bundler, no TypeScript, no ORM.
  `src/worker.js` routes `/api/*` to handler modules in `src/routes/*.js`
  by matching `pathname`/`method`.
- **D1** (`env.DB`, SQLite) for the database. Every query is a raw SQL
  string. Migrations are numbered files in `migrations/`, applied via
  `wrangler d1 execute`. Check `migrations/` for the current highest number
  before writing a new one.
- **Frontend**: plain HTML files at the repo root with inline
  `<script>` blocks — no framework. `dashboard.html` (clipper),
  `admin.html` (founder/admin), `client-dashboard.html` (brand),
  `index.html` (public marketing + campaign listing).
- **Refresh/sync engine**: `src/refresh-jobs.js` — a chained job system
  built specifically to work around Cloudflare's Free-tier 50-subrequest-
  per-invocation cap. Jobs are queued (Cloudflare Queues) and resume across
  multiple Worker invocations. `src/earnings.js`/`src/payouts.js` own the
  money math and settlement logic.
- **Auth**: Instagram via Meta's Instagram API with Instagram Login, YouTube
  via Google OAuth (`src/instagram.js`, `src/youtube.js`,
  `src/routes/instagram-auth.js`, `src/routes/youtube-auth.js`). The
  Google Cloud OAuth consent screen is in **Production** publishing status
  (moved from Testing on 2026-08-26 specifically to remove the 7-day
  refresh-token expiry Testing status imposes).

## Tooling that exists — use it before assuming something works

- `npm test` — currently well over 100 tests, run before every deploy.
  Includes `test/sql-queries.test.mjs`, which validates every SQL string in
  `src/` against the real schema (built via `node:sqlite` in
  `test/helpers/real-schema.mjs`) — this catches phantom-column bugs
  before they reach production.
  Also `test/module-integrity.test.mjs` (dangling imports) and
  `test/page-functions.test.mjs` (an HTML page calling a JS function that
  no longer exists) — both exist because real production incidents were
  exactly those bug classes.
- `npx wrangler deploy` — deploys. `npx wrangler d1 execute clipgrow
  --remote --command "..."` — direct production DB queries (prefer this
  over the D1 MCP connector; see common-mistakes.md).
- Global memory at `~/.claude/projects/<hash>/memory/` also has
  topic-specific notes (verification status, payout model decisions,
  business registration) — those persist automatically across any session
  in this folder and are complementary to these `.claude/notes/` files,
  not a duplicate of them.

## Reading order for a new session

1. This file, once, for orientation.
2. `.claude/notes/whats-next.md` if picking up open work.
3. `.claude/notes/common-mistakes.md` **only** when something looks like a
   bug you might have seen before — don't read it preemptively every time.
4. `.claude/notes/changelog.md` only if asked for history, or to check
   whether something specific has already been done.
