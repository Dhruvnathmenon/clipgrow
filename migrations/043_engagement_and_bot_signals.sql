-- Bot-view detection: informational-only signals (founder-approved plan,
-- 2026-09-15). Nothing here changes earning/status/lock behaviour -- every
-- column added below is read-only metadata surfaced as a traffic-light
-- badge (src/routes/admin.js, src/routes/moderator.js, admin.html,
-- moderator.html), never acted on automatically. The plan's own research
-- found no reliable per-clip formula exists (even academic researchers with
-- full ground-truth visibility on a real botting operation couldn't build
-- one), so the primary signal is cross-account timing correlation
-- (src/bot-correlation.js, SynchroTrap-style) rather than a single-clip
-- score; src/bot-detection.js's single-clip heuristics are secondary
-- context only and are capped below the 'high' tier on their own.

-- Engagement fields bundled into the same sync call that already fetches
-- views (Instagram: one Insights call with a comma-separated metric list,
-- zero extra quota vs. today; YouTube: statistics fields already present
-- in the videos.list response but previously discarded). NULL means "not
-- available for this platform/media", not "zero" -- YouTube never
-- populates saved/shares/avg_watch_time_sec.
ALTER TABLE submissions ADD COLUMN likes INTEGER;
ALTER TABLE submissions ADD COLUMN comments INTEGER;
ALTER TABLE submissions ADD COLUMN saved INTEGER;
ALTER TABLE submissions ADD COLUMN shares INTEGER;
ALTER TABLE submissions ADD COLUMN avg_watch_time_sec REAL;

-- The risk score driving the None/Low/Medium/High badge. bot_score is
-- 0-100; the tier itself is derived from it on read (src/bot-detection.js's
-- tierForScore) rather than stored, so the two can never drift apart.
-- bot_score_reason is short, human-readable text -- same free-text
-- convention as staff_audit_log/error_log/client_clip_flags.note.
-- bot_correlation_cluster_id is NULL unless this clip is part of a flagged
-- cross-account timing cluster (src/bot-correlation.js); a shared,
-- non-null value across several submissions means they were flagged
-- together, in the same pass. NULL bot_score means "not yet scored" (e.g.
-- brand new, no sync yet) and renders as no badge at all.
ALTER TABLE submissions ADD COLUMN bot_score INTEGER;
ALTER TABLE submissions ADD COLUMN bot_score_reason TEXT;
ALTER TABLE submissions ADD COLUMN bot_correlation_cluster_id INTEGER;
ALTER TABLE submissions ADD COLUMN bot_scored_at INTEGER;

-- Delta-only view-growth time series -- a sync that reads back an
-- unchanged view count writes nothing here, so this table's size tracks
-- real view-growth events, not sync frequency. This is what makes any
-- velocity/changepoint/correlation signal possible at all: there was
-- previously no history anywhere in the schema to compare a new reading
-- against (submissions.views is blind-overwritten on every sync).
-- clipper_id is denormalised from submissions here purely so the
-- correlation detector can group by clipper without a join per row.
CREATE TABLE IF NOT EXISTS submission_view_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  clipper_id INTEGER NOT NULL,
  views INTEGER NOT NULL,
  likes INTEGER,
  comments INTEGER,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_view_snapshots_submission ON submission_view_snapshots(submission_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_view_snapshots_recorded ON submission_view_snapshots(recorded_at);
