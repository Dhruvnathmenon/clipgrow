-- One durable place for things that actually go wrong for a clipper,
-- moderator, or admin (src/error-log.js). Before this, an Instagram/YouTube
-- connect failure was a one-time toast on the dashboard and nothing more,
-- with no record surviving the page load. Deliberately separate from
-- staff_audit_log (migration 023), which records successful staff actions,
-- not failures.
--
-- actor_type: 'clipper' | 'moderator' | 'admin' | 'client' | 'anonymous'
-- actor_id: clipper/moderator/client id where known, NULL for admin/anonymous
-- actor_label: denormalised at write time, same reasoning as staff_audit_log
-- source: 'instagram_oauth' | 'youtube_oauth' | 'api' | ...
-- detail: stack trace or extra context, for when Claude needs to dig in
-- path: request path or campaign context, whichever applies
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL,
  actor_id INTEGER,
  actor_label TEXT,
  source TEXT NOT NULL,
  code TEXT,
  message TEXT NOT NULL,
  detail TEXT,
  path TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_error_log_created ON error_log(created_at);
CREATE INDEX IF NOT EXISTS idx_error_log_resolved ON error_log(resolved_at);
