-- Self-tracked (not Cloudflare's GraphQL Analytics API) daily D1 rows
-- read/written counter, so an admin can see usage heading toward Workers
-- Paid's monthly included allowance BEFORE an unexpected overage bill
-- shows up -- the cost-side sibling of the 2026-09-13 outage (D1's
-- Free-tier daily quota exhausted with zero warning, see commit
-- 8443202), now that the account is on Paid and the risk shape changed
-- from "hard daily failure" to "monthly overage billing." Keyed by UTC
-- day so "today" is unambiguous; monthly totals are a SUM over one
-- calendar month's rows, computed at read time -- this table stays
-- purely granular, with no monthly state of its own.
CREATE TABLE IF NOT EXISTS d1_usage_daily (
  day TEXT PRIMARY KEY,        -- 'YYYY-MM-DD', UTC
  rows_read INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Threshold-alert dedup, kept separate from d1_usage_daily on purpose: a
-- monthly alert's "already warned" state has nowhere natural to live on a
-- per-day table (tying it to "the row for the 1st of the month" would
-- break if that specific day never sees a flush). `scope` is
-- "<metric>:<YYYY-MM>" (e.g. "d1:2026-09") so this same table covers
-- future self-tracked dimensions (Workers requests, Queue operations)
-- without another migration -- one row per metric per month, not per day.
CREATE TABLE IF NOT EXISTS platform_usage_alerts (
  scope TEXT PRIMARY KEY,
  warned_70_at INTEGER,
  warned_90_at INTEGER
);

-- One row, always id = 1: the single admin-togglable "pause heavy
-- background work" switch (the 6-hourly refresh cron's job creation, and
-- an admin's own manual "full refresh" trigger -- NOT the rest of the
-- site, which keeps working untouched). A singleton on purpose -- this is
-- one flag, not a generic feature-flag system, and building the latter
-- for a system with exactly one flag today would be solving a problem
-- that does not exist yet.
CREATE TABLE IF NOT EXISTS system_pause (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL DEFAULT 0,
  paused_at INTEGER,
  paused_by TEXT,
  reason TEXT
);
INSERT INTO system_pause (id, paused) VALUES (1, 0);
