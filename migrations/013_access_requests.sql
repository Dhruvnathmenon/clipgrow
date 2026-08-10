-- Gated per-platform account onboarding.
--
-- Until now the Connect button was always reachable: a clipper could attempt
-- OAuth at any time and, if their account was not yet an approved tester, they
-- would hit a typed NOT_A_TESTER error explaining what to do. That is honest
-- but it lets people walk into a wall, and it fails differently on each
-- platform.
--
-- This replaces it with an explicit gate: request access -> admin approves ->
-- connect unlocks. The clipper only ever sees one next action, so there is no
-- state where they can attempt something that cannot succeed.
--
-- The queue was Instagram-only (tester_requests, keyed on ig_username).
-- Generalising it:
--   * `identifier` holds an Instagram handle OR a Google account email
--   * keyed per (clipper, campaign, platform), because the one-account-per-
--     live-campaign rule means each campaign needs a different account, and
--     each account needs its own approval

ALTER TABLE tester_requests ADD COLUMN identifier TEXT;

-- Existing rows are all Instagram; their handle is the identifier.
UPDATE tester_requests SET identifier = ig_username WHERE identifier IS NULL;

CREATE INDEX IF NOT EXISTS idx_tester_scope ON tester_requests(clipper_id, campaign_id, platform);

-- Backfill approvals for accounts that are ALREADY connected.
--
-- This is the part that protects production. Two live Instagram accounts were
-- connected before this gate existed, and one of them has no request row at
-- all. Without this backfill they would be fine today (they are connected) but
-- would be locked out the moment they needed to reconnect after a token
-- expiry -- a failure that would only surface weeks later, which is exactly
-- the kind of delayed breakage worth spending a migration to avoid.
INSERT INTO tester_requests (clipper_id, ig_username, identifier, platform, status, campaign_id, note, requested_at, confirmed_at)
  SELECT p.clipper_id,
         a.username,
         a.username,
         a.platform,
         'confirmed',
         p.campaign_id,
         'Auto-approved: account was already connected before approval gating existed.',
         COALESCE(a.connected_at, 0),
         COALESCE(a.connected_at, 0)
  FROM participation_accounts pa
  JOIN social_accounts a ON a.id = pa.account_id
  JOIN participations p ON p.id = pa.participation_id
  WHERE NOT EXISTS (
    SELECT 1 FROM tester_requests t
    WHERE t.clipper_id = p.clipper_id
      AND t.campaign_id = p.campaign_id
      AND t.platform = a.platform
  );

-- Any pre-existing Instagram request that was raised without campaign context
-- still counts for the campaign it was raised from; nothing to change there.
