-- Payment lock-in.
--
-- Until now `submissions.earning` was recomputed from scratch on every sync,
-- for the life of the campaign. That is correct for money not yet sent, but
-- catastrophic once money HAS been sent: disqualifying a clip, lowering a CPM
-- or raising a threshold would silently rewrite history and erase the fact
-- that a real UPI transfer had already gone out for it.
--
-- Locking closes a clip out permanently. `locked_earning` is the amount that
-- was actually settled; the allocator treats it as historical fact and never
-- recalculates it. Views the clip gains after the lock earn nothing -- a
-- locked clip is done.
ALTER TABLE submissions ADD COLUMN locked_at INTEGER;
ALTER TABLE submissions ADD COLUMN locked_earning INTEGER;
ALTER TABLE submissions ADD COLUMN lock_reason TEXT;   -- paid | below_min | written_off
ALTER TABLE submissions ADD COLUMN payment_id INTEGER REFERENCES payments(id);
CREATE INDEX IF NOT EXISTS idx_submissions_lock ON submissions(clipper_id, locked_at);
CREATE INDEX IF NOT EXISTS idx_submissions_payment ON submissions(payment_id);

-- `last_synced_at` is stamped on failures too, so it cannot answer "when did
-- we last actually hear a real view count for this clip?". That question is
-- what tells a clipper (and the admin) whether a clip is genuinely stuck.
ALTER TABLE submissions ADD COLUMN last_ok_sync_at INTEGER;

-- What a payment settled, for the audit trail. The authoritative link is
-- submissions.payment_id; these are a denormalised summary so a payment row
-- still reads correctly on its own in the CSV export.
ALTER TABLE payments ADD COLUMN clip_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN clips_total INTEGER NOT NULL DEFAULT 0;

-- Client logins: read-only observers scoped to their own campaign(s).
-- Same password scheme as clippers (PBKDF2 via src/auth.js).
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  company_name TEXT,
  contact_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- active | disabled
  created_at INTEGER NOT NULL
);

-- Many-to-many so a returning client keeps one login across campaigns rather
-- than needing a fresh username each time.
CREATE TABLE IF NOT EXISTS client_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  granted_at INTEGER NOT NULL,
  UNIQUE(client_id, campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_client_campaigns_client ON client_campaigns(client_id);
