-- Multi-platform support: YouTube alongside Instagram.
--
-- social_accounts was built platform-agnostic from the start (migration 003),
-- so the account model itself needs no reshaping. What does need to change:
--
--  1. Google's OAuth model differs from Instagram's. Instagram issues one
--     long-lived token that refreshes itself. Google issues a short access
--     token (about an hour) plus a permanent refresh token, so the refresh
--     token has to be stored separately.
--  2. A participation could previously hold exactly ONE account, which makes
--     running Instagram and YouTube on the same campaign impossible.
--  3. Duplicate protection on submissions was only a code-level SELECT, which
--     is a race, and it was not scoped by platform.

-- ---------------------------------------------------------------- accounts
ALTER TABLE social_accounts ADD COLUMN refresh_token TEXT;
-- Platform-specific extras that do not deserve their own columns, e.g. a
-- YouTube channel's uploads playlist id.
ALTER TABLE social_accounts ADD COLUMN meta_json TEXT;

-- ------------------------------------------------------------- submissions
-- Denormalised from the account so dedup, filtering and display never need a
-- join, and so a submission still knows its platform if its account is later
-- deleted.
ALTER TABLE submissions ADD COLUMN platform TEXT NOT NULL DEFAULT 'instagram';
ALTER TABLE submissions ADD COLUMN duration_seconds INTEGER;
-- 1 = Short, 0 = not a Short, NULL = not determined / not applicable.
ALTER TABLE submissions ADD COLUMN is_short INTEGER;
-- Whether this clip may earn at all, decided by the platform adapter at import
-- time. Keeps platform rules (YouTube: Shorts only) out of the allocator, so
-- the money logic stays platform-agnostic.
ALTER TABLE submissions ADD COLUMN eligible INTEGER NOT NULL DEFAULT 1;

UPDATE submissions
   SET platform = COALESCE(
     (SELECT a.platform FROM social_accounts a WHERE a.id = submissions.account_id),
     'instagram'
   );

-- Real database-level duplicate protection, scoped per platform. Previously a
-- concurrent double-submit could slip two rows past the code-level check.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_platform_media ON submissions(platform, ig_media_id);
CREATE INDEX IF NOT EXISTS idx_sub_platform ON submissions(campaign_id, platform);

-- --------------------------------------------------------------- campaigns
-- Which platforms this campaign accepts, comma-separated. Existing campaigns
-- stay Instagram-only, so nothing silently starts accepting YouTube clips.
-- Named allowed_platforms, not platforms, to avoid colliding with the
-- free-text `platforms` field already inside blueprint_json.
ALTER TABLE campaigns ADD COLUMN allowed_platforms TEXT NOT NULL DEFAULT 'instagram';

-- --------------------------------------------------- participation accounts
-- One connected account per platform per participation, replacing the single
-- participations.account_id FK. That column is left in place and kept in sync
-- for Instagram so nothing that still reads it can break mid-deploy.
CREATE TABLE IF NOT EXISTS participation_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participation_id INTEGER NOT NULL REFERENCES participations(id),
  account_id INTEGER NOT NULL REFERENCES social_accounts(id),
  platform TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  UNIQUE(participation_id, platform)
);
CREATE INDEX IF NOT EXISTS idx_part_accounts_account ON participation_accounts(account_id);

INSERT OR IGNORE INTO participation_accounts (participation_id, account_id, platform, linked_at)
  SELECT p.id, p.account_id, COALESCE(a.platform, 'instagram'), COALESCE(p.joined_at, 0)
  FROM participations p
  JOIN social_accounts a ON a.id = p.account_id
  WHERE p.account_id IS NOT NULL;

-- Google account emails awaiting test-user access, mirroring tester_requests
-- for Instagram. Google's unverified-app cap is 100 users for the lifetime of
-- the Cloud project, so who has been granted access is worth tracking.
ALTER TABLE tester_requests ADD COLUMN platform TEXT NOT NULL DEFAULT 'instagram';
