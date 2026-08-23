-- Chained refresh jobs (Phase 0 of the queue-based refresh system).
--
-- A refresh is no longer one flat pass that must fit inside a single Worker
-- invocation. It is a job with an explicit work list that is consumed across
-- as many invocations as it takes, each staying under Cloudflare's
-- per-invocation external-subrequest ceiling and handing off via Queues.
CREATE TABLE IF NOT EXISTS refresh_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                              -- 'global' | 'clipper'
  clipper_id INTEGER,                              -- NULL for 'global'
  triggered_by TEXT NOT NULL,                      -- 'cron' | 'admin' | 'clipper'
  -- 1 for the automatic cron (only re-check clips whose 1h cooldown lapsed --
  -- without this an account with 60 clips would need 240 calls/hour from
  -- routine syncing alone, over Instagram's 200/hr limit before any human
  -- asks for anything). 0 for human-triggered full refreshes, which are a
  -- deliberate "show me the truth right now" and check every eligible clip.
  respect_cooldown INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued',           -- queued|running|done|failed
  -- The exact remaining work. This is the resume cursor: an invocation that
  -- dies leaves this intact, so a retry re-does nothing already completed.
  pending_json TEXT NOT NULL DEFAULT '[]',
  invocations INTEGER NOT NULL DEFAULT 0,
  clips_fetched INTEGER NOT NULL DEFAULT 0,
  clips_failed INTEGER NOT NULL DEFAULT 0,
  -- Locked/deleted mid-flight: neither a success nor a real failure, and
  -- conflating it with either would misreport what actually happened.
  clips_skipped INTEGER NOT NULL DEFAULT 0,
  imported INTEGER NOT NULL DEFAULT 0,
  accounts_json TEXT,                              -- per-account budget + deferred counts
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);

-- "Block the second trigger" enforced by the DATABASE, not by an app-level
-- check-then-insert, which would race between the check and the insert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_jobs_one_global
  ON refresh_jobs(kind) WHERE kind = 'global' AND status IN ('queued','running');
CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_jobs_one_per_clipper
  ON refresh_jobs(clipper_id) WHERE clipper_id IS NOT NULL AND status IN ('queued','running');

CREATE INDEX IF NOT EXISTS idx_refresh_jobs_status ON refresh_jobs(status, updated_at);

-- Cross-tier account lock: an admin global job and a clipper's own job are
-- separate rows, so the per-job indexes above cannot stop them touching the
-- same Instagram account at once. Claimed lazily, only while an invocation is
-- actually working that account.
ALTER TABLE social_accounts ADD COLUMN active_job_id INTEGER;
