-- Moderator staff accounts. Individual named logins (not a shared password
-- like ADMIN_PASSWORD) so each moderator can be identified, disabled, and
-- re-passworded independently. Only the admin can write to this table
-- (src/routes/admin.js) -- a moderator can never create or manage another
-- moderator, so unlike `clippers` below there is no created_by column
-- here: every row is, by construction, admin-created.
CREATE TABLE IF NOT EXISTS moderators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  display_name TEXT,
  -- 'active' | 'disabled', validated in JS -- this project never uses SQL
  -- CHECK constraints (see PART_STATUSES / CAMPAIGN_STATUSES / TESTER_STATUSES
  -- in admin.js for the existing convention). Deactivating (never deleting)
  -- keeps their name attached to every review/audit-log row they ever
  -- produced -- exactly why submission_reviews and staff_audit_log
  -- denormalise the name at write time instead of joining this table live.
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

-- One verdict per submitted video. A fully separate table from
-- `submissions` -- joined only by submission_id -- so a review can NEVER
-- touch earning, locked_at, locked_earning, lock_reason or payment_id.
-- This migration does not add, alter, or index anything on `submissions`
-- itself.
CREATE TABLE IF NOT EXISTS submission_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- UNIQUE, not just indexed: a submission is reviewed exactly once. That
  -- invariant is what makes the "moves to Reviewed" panel and the live
  -- counters (today's total, each reviewer's own count) safe to compute
  -- with a plain COUNT(*) -- the same video can never be counted twice,
  -- even under a client retry racing the first insert.
  submission_id INTEGER NOT NULL UNIQUE REFERENCES submissions(id),
  verdict TEXT NOT NULL,        -- 'tick' | 'cross' | 'skip', validated in JS
  -- Free text the moderator types alongside the verdict. Shown back to the
  -- clipper on their own dashboard's Reviews tab (src/routes/clipper.js) --
  -- the one piece of moderator-authored text that IS meant to reach the
  -- clipper, unlike clipper_notes below, which never is.
  feedback TEXT,
  reviewer_type TEXT NOT NULL,  -- 'admin' | 'moderator'
  -- NULL for an admin review -- the admin session carries the literal id
  -- 'admin' (auth.js createSessionCookie('admin','admin',...)), not a real
  -- numeric staff row, so there is nothing to store here for them.
  reviewer_id INTEGER,
  -- Denormalised at review time: a moderator's display_name can change
  -- later, or their account can be deactivated, but the review must still
  -- read "reviewed by Jane Doe" forever.
  reviewer_name TEXT NOT NULL,
  reviewed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submission_reviews_reviewer
  ON submission_reviews(reviewer_type, reviewer_id, reviewed_at);
CREATE INDEX IF NOT EXISTS idx_submission_reviews_reviewed_at
  ON submission_reviews(reviewed_at);

-- Staff-only notes on a clipper. Never joined into, or exposed by, any
-- src/routes/clipper.js endpoint -- that IS the entire enforcement of
-- "never shown to the clipper" (same trust model as mismatch_approved_as
-- in admin.js, deliberately left out of publicAccount()).
CREATE TABLE IF NOT EXISTS clipper_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clipper_id INTEGER NOT NULL REFERENCES clippers(id),
  note TEXT NOT NULL,
  author_type TEXT NOT NULL,    -- 'admin' | 'moderator'
  author_id INTEGER,            -- NULL for admin, see reviewer_id above
  author_name TEXT NOT NULL,    -- denormalised, same reasoning as reviewer_name
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clipper_notes_clipper ON clipper_notes(clipper_id);

-- Admin-only audit trail. action/target_type are free text rather than one
-- column per action type, so a future action (e.g. access-request approval,
-- once approvals are ever delegated) needs zero further migration -- it's
-- just a new action string written from src/audit.js.
CREATE TABLE IF NOT EXISTS staff_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_type TEXT NOT NULL,     -- 'admin' | 'moderator'
  staff_id INTEGER,             -- NULL for admin
  staff_name TEXT NOT NULL,     -- denormalised, same reasoning as reviewer_name
  action TEXT NOT NULL,         -- e.g. 'clipper_kicked', 'refresh_triggered'
  target_type TEXT NOT NULL,    -- e.g. 'clipper', 'social_account', 'participation'
  target_id INTEGER,
  target_label TEXT,            -- denormalised human-readable label, e.g. a username
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON staff_audit_log(created_at);

-- Attributes clipper creation to whichever staff member actually did it.
-- Three columns, not one, for the same reason submission_reviews and
-- staff_audit_log denormalise: the name must survive a moderator's name
-- changing, or their account being deactivated, later. NULL on every
-- pre-existing row -- there is no way to reconstruct who created a clipper
-- before this migration; the admin/moderator UI renders that as "—".
ALTER TABLE clippers ADD COLUMN created_by_type TEXT;
ALTER TABLE clippers ADD COLUMN created_by_id INTEGER;
ALTER TABLE clippers ADD COLUMN created_by_name TEXT;

-- No changes to refresh_jobs: triggered_by (migration 017) is already a
-- free-text column with no CHECK constraint, so a moderator-triggered
-- resync passes the string 'moderator:<id>' straight through it unchanged.
-- See src/routes/moderator.js's resync endpoint.
