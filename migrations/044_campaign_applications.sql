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
  video_url     TEXT NOT NULL,
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

-- Grandfather everyone already on a campaign.
--
-- Connecting an account is about to require an approved application. Without
-- this, all 60 clippers currently holding a live participation would be
-- locked out the moment they tried to connect a new or reconnected account,
-- for a step that did not exist when they joined. attempt 0 marks these as
-- never having gone through review, so they are distinguishable from a real
-- approval in any later audit.
INSERT INTO campaign_applications
  (clipper_id, campaign_id, video_url, attempt, status,
   reviewer_type, reviewer_name, reviewer_note, reviewed_at, created_at)
SELECT p.clipper_id, p.campaign_id, '', 0, 'approved',
       'system', 'System',
       'Joined before campaign applications existed -- approved automatically so an existing clipper is never locked out of connecting an account.',
       p.joined_at, p.joined_at
FROM participations p
WHERE p.status != 'kicked';
