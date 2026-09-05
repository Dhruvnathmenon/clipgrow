-- Supports pruneOldEvents() in src/refresh-events.js (called from every
-- createRefreshJob(), the same "opportunistic, safe to call often" pattern
-- ig_api_calls already used) -- this table had zero cleanup at all before,
-- unlike its sibling rolling ledger.
CREATE INDEX IF NOT EXISTS idx_refresh_events_created_at ON refresh_events(created_at);
