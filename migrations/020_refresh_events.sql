-- Durable, per-clip history of what a refresh actually did.
--
-- Before this table every record of a failure was last-write-wins and mostly
-- unattributable:
--   * refresh_jobs.clips_failed is a bare COUNT -- no ids, no reasons.
--   * refresh_jobs.error was never set to a non-NULL value by any code path.
--   * refresh_jobs.accounts_json holds one error code per ACCOUNT, so it has
--     no clip, no permalink and no campaign, and nothing ever reads it once
--     the panel closes.
--   * submissions.sync_error is a single slot, overwritten on the next run and
--     cleared to NULL on the next success -- so the reason a clip failed
--     yesterday is gone the moment it succeeds today.
--   * The adapters generate genuinely useful `message` and `fix` text for every
--     error (IG_ERRORS / YT_ERRORS) and it was thrown away; only the bare code
--     ever reached the database.
--
-- The result was an admin who could see THAT 12 clips failed and never which
-- ones, for whom, on which campaign, or why. This table is the answer to
-- "which video of which clipper failed, and what do I do about it".
--
-- Deliberately no FOREIGN KEY on job_id. ig_api_calls carries a NOT NULL key
-- onto social_accounts and that is exactly what made disconnecting an account
-- fail with a bare "internal server error" for every account that had ever
-- synced. This table is an append-only log; it must never be able to block a
-- delete elsewhere.
CREATE TABLE IF NOT EXISTS refresh_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        INTEGER NOT NULL,
  account_id    INTEGER,
  clipper_id    INTEGER,
  campaign_id   INTEGER,
  submission_id INTEGER,
  platform      TEXT,
  permalink     TEXT,
  -- ok | failed | skipped
  outcome       TEXT NOT NULL,
  -- What the item was: view | import | account
  leg           TEXT,
  -- Actionable bucket, so the panel can group by what the admin must DO:
  -- reauth | rate_limit | gone | permission | network | config | unknown
  kind          TEXT,
  -- The adapter's raw code, plus the human text it already generates and which
  -- was previously discarded.
  code          TEXT,
  message       TEXT,
  fix           TEXT,
  created_at    INTEGER NOT NULL
);

-- The panel's main read: everything that happened in one job, failures first.
CREATE INDEX IF NOT EXISTS idx_refresh_events_job ON refresh_events(job_id, outcome);
-- "has this clip been failing for days?" -- the history sync_error cannot keep.
CREATE INDEX IF NOT EXISTS idx_refresh_events_sub ON refresh_events(submission_id, created_at);
-- Pruning old runs.
CREATE INDEX IF NOT EXISTS idx_refresh_events_created ON refresh_events(created_at);
