-- Step 1 of the new two-step campaign onboarding: a clipper submits a video
-- against a specific campaign, a moderator approves or rejects it with
-- written feedback, and only an approved application unlocks step 2
-- (connecting the social account, which is the existing tester_requests
-- flow in src/access.js -- unchanged by this).
--
-- This cannot reuse `submissions`. A submissions row is only ever created
-- for a clip on an ALREADY-CONNECTED account, and its insert path verifies
-- the post belongs to that account via a live API call (src/routes/
-- clipper.js). The whole point here is a video reviewed BEFORE any account
-- is connected, so it is a genuinely separate entity.
--
-- One row per ATTEMPT rather than one row per clipper+campaign that gets
-- overwritten. The attempt history is the audit trail for a dispute, and it
-- makes the three-strike rule a plain COUNT rather than a counter column
-- that can drift from the rows it claims to describe -- the same reasoning
-- submission_reviews already follows by storing one row per verdict.
CREATE TABLE IF NOT EXISTS campaign_applications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  clipper_id    INTEGER NOT NULL REFERENCES clippers(id),
  campaign_id   INTEGER NOT NULL REFERENCES campaigns(id),
  -- Nullable because a submission can arrive two ways: a file attached and
  -- uploaded to our Drive (drive_file_id below, the normal path), or a
  -- pasted link. Grandfathered rows have neither -- they predate the whole
  -- process and were never reviewed.
  video_url     TEXT,
  -- The Drive object behind an attached file. Held so a verdict can act on
  -- the file itself: approved is deleted at once, rejected is moved to the
  -- rejected folder and purged after DRIVE_REJECTED_RETENTION_MS. NULL once
  -- the file is gone, which is also what stops the purge sweep picking the
  -- same row up twice.
  drive_file_id TEXT,
  file_name     TEXT,
  file_size     INTEGER,
  attempt       INTEGER NOT NULL,
  -- 'pending' | 'approved' | 'rejected'
  status        TEXT NOT NULL DEFAULT 'pending',
  -- Who reviewed it, denormalised at write time exactly like
  -- staff_audit_log.staff_name and client_clip_flags.resolved_by, so the
  -- record still reads correctly after a moderator is renamed or removed.
  reviewer_type TEXT,
  reviewer_id   INTEGER,
  reviewer_name TEXT,
  -- Mandatory on a real verdict. src/reviews.js already requires feedback on
  -- every verdict including a skip, and a rejection a clipper cannot act on
  -- is worse here, where they only get three tries.
  reviewer_note TEXT,
  reviewed_at   INTEGER,
  created_at    INTEGER NOT NULL
);

-- Counting attempts and reading a clipper's current state for one campaign
-- are both per clipper+campaign, which is every read this table serves
-- outside the moderator queue.
CREATE INDEX IF NOT EXISTS idx_campaign_applications_clipper_campaign
  ON campaign_applications(clipper_id, campaign_id);
-- The moderator queue: oldest pending first.
CREATE INDEX IF NOT EXISTS idx_campaign_applications_status
  ON campaign_applications(status, created_at);
-- At most one application in flight per clipper per campaign. A double-tap
-- on Submit is then refused by the database rather than by a check-then-
-- insert that can race, the same guarantee client_clip_flags gets from its
-- own one-open partial index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_applications_one_pending
  ON campaign_applications(clipper_id, campaign_id) WHERE status = 'pending';

-- The gate has a kill switch. Everything in this feature ships switched OFF,
-- so deploying it changes nothing for anyone; an admin turns it on when the
-- moderators are ready, and can turn it straight back off if something is
-- wrong -- no redeploy either way. Missing row == off, deliberately: if this
-- table cannot be read, the safe failure is "the old flow keeps working",
-- not "every clipper is locked out of connecting".
CREATE TABLE IF NOT EXISTS feature_flags (
  key        TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER,
  updated_by TEXT
);
INSERT OR IGNORE INTO feature_flags (key, enabled, updated_at) VALUES ('applications_gate', 0, NULL);

-- Grandfathering is deliberately NOT done here. It runs at the moment the gate
-- is switched on (grandfatherExisting in src/applications.js), because a
-- snapshot taken now would already be stale by then: anyone who connected an
-- account between this migration and the switch-on would be sent back to
-- step 1 for having done nothing wrong.
