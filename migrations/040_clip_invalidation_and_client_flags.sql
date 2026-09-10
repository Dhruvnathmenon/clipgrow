-- Two related pieces of the same "this clip can be ruled out" story.
--
-- 1. Manual-invalidation metadata on submissions. The `disqualified` status
--    already zeroes a clip's earning and hands its budget back to the campaign
--    pool (src/earnings.js allocateCampaignEarnings) -- but it recorded nothing
--    about WHY or on whose say-so. These columns capture the reason the admin
--    types at flag time, for the audit trail and any later dispute. Cleared
--    again by revalidate (the "false alarm" undo).
ALTER TABLE submissions ADD COLUMN invalidated_at INTEGER;
ALTER TABLE submissions ADD COLUMN invalidated_by TEXT;
ALTER TABLE submissions ADD COLUMN invalidated_reason TEXT;

-- 2. Client-raised clip flags. The client portal is otherwise strictly
--    read-only (src/routes/client.js) and this is the single write it accepts:
--    a brand reporting one clip on their own campaign as off-guideline or
--    botted. It does NOT change the clip on its own -- it raises an alert on
--    the admin Overview banner. The admin resolves it from the clipper page
--    (invalidate the clip, which auto-marks the flag 'actioned') or dismisses
--    it as a false alarm.
--
-- status: 'open' | 'actioned' | 'dismissed'
-- note: optional free text from the client
-- resolved_by: denormalised staff name at write time, same as staff_audit_log
CREATE TABLE IF NOT EXISTS client_clip_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  campaign_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_clip_flags_status ON client_clip_flags(status, created_at);
-- One open flag per client per clip -- a repeat click is idempotent, not a
-- second row. A dismissed-then-reflagged clip is still allowed (the partial
-- index only constrains the 'open' rows).
CREATE UNIQUE INDEX IF NOT EXISTS idx_client_clip_flags_one_open
  ON client_clip_flags(submission_id, client_id) WHERE status = 'open';
