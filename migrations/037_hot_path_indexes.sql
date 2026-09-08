-- Two queries added this session scan a whole table filtered on columns
-- that had no supporting index -- harmless at today's row counts, but both
-- run often enough (one on every Overview page load, one every cron cycle)
-- that it's worth having the index before it's a "why did this get slow"
-- surprise later rather than a planned addition now.

-- admin.js's /api/admin/overview problemCandidates query:
--   WHERE a.status = 'needs_reauth' OR (a.status = 'connected' AND ...)
-- social_accounts already has idx_accounts_clipper (clipper_id), which this
-- scan doesn't touch at all.
CREATE INDEX IF NOT EXISTS idx_accounts_status ON social_accounts(status);

-- refresh-jobs.js's removeInactiveJoins, run on every 6-hourly cron sweep:
--   WHERE p.status = 'active' AND p.inactive_at IS NULL AND p.joined_at <= ?
-- participations already has idx_part_campaign/idx_part_clipper, neither of
-- which this scan filters on either.
CREATE INDEX IF NOT EXISTS idx_part_status_inactive ON participations(status, inactive_at);
