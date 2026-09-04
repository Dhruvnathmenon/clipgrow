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
