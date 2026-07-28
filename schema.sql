CREATE TABLE IF NOT EXISTS clippers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  display_name TEXT,
  ig_username TEXT,
  ig_user_id TEXT,
  ig_access_token TEXT,
  ig_token_expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  cpm INTEGER NOT NULL,
  budget INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_optins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clipper_id INTEGER NOT NULL REFERENCES clippers(id),
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  joined_at INTEGER NOT NULL,
  UNIQUE(clipper_id, campaign_id)
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clipper_id INTEGER NOT NULL REFERENCES clippers(id),
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  ig_media_id TEXT NOT NULL,
  permalink TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  earning INTEGER NOT NULL DEFAULT 0,
  last_synced_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_optins_campaign ON campaign_optins(campaign_id);
CREATE INDEX IF NOT EXISTS idx_submissions_campaign_created ON submissions(campaign_id, created_at);
CREATE INDEX IF NOT EXISTS idx_submissions_clipper ON submissions(clipper_id);
