-- Social accounts a clipper has authorised. Platform-agnostic so YouTube slots
-- in later as another `platform` value with no schema change.
CREATE TABLE IF NOT EXISTS social_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clipper_id INTEGER NOT NULL REFERENCES clippers(id),
  platform TEXT NOT NULL DEFAULT 'instagram',
  external_id TEXT NOT NULL,
  username TEXT,
  account_type TEXT,
  access_token TEXT,
  token_expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'connected',   -- connected | needs_reauth | revoked
  last_error_code TEXT,
  last_error_at INTEGER,
  last_checked_at INTEGER,
  connected_at INTEGER NOT NULL,
  UNIQUE(clipper_id, platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_accounts_clipper ON social_accounts(clipper_id);

-- Replaces campaign_optins. Each participation binds one clipper to one
-- campaign via one specific social account, and carries its own status so a
-- clipper can be paused or removed per campaign rather than globally.
CREATE TABLE IF NOT EXISTS participations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clipper_id INTEGER NOT NULL REFERENCES clippers(id),
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  account_id INTEGER REFERENCES social_accounts(id),
  status TEXT NOT NULL DEFAULT 'active',      -- active | paused | kicked
  status_note TEXT,
  status_changed_at INTEGER,
  joined_at INTEGER NOT NULL,
  UNIQUE(clipper_id, campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_part_campaign ON participations(campaign_id);
CREATE INDEX IF NOT EXISTS idx_part_clipper ON participations(clipper_id);

-- Payment ledger: what has actually been sent to a clipper. Earnings are
-- derived from submissions; "received" is derived from here.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clipper_id INTEGER NOT NULL REFERENCES clippers(id),
  campaign_id INTEGER REFERENCES campaigns(id),
  amount INTEGER NOT NULL,
  method TEXT,
  reference TEXT,
  note TEXT,
  paid_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_clipper ON payments(clipper_id);

-- Carry over any existing opt-ins, then retire the old table.
INSERT INTO participations (clipper_id, campaign_id, status, joined_at)
  SELECT clipper_id, campaign_id, 'active', joined_at FROM campaign_optins
  WHERE NOT EXISTS (
    SELECT 1 FROM participations p
    WHERE p.clipper_id = campaign_optins.clipper_id AND p.campaign_id = campaign_optins.campaign_id
  );
DROP TABLE IF EXISTS campaign_optins;

-- Which account a submission was posted from, and whether it still counts.
ALTER TABLE submissions ADD COLUMN account_id INTEGER;
ALTER TABLE submissions ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE submissions ADD COLUMN sync_error TEXT;
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(campaign_id, status);
