-- Manual Instagram Tester onboarding queue. The Meta app is in Development
-- Mode, so an Instagram account must be an accepted app Tester before OAuth
-- can ever succeed for it. This table tracks that admin-mediated step
-- explicitly instead of clippers silently hitting a "not a tester" OAuth
-- failure with no path forward.
--
-- Tester status is app-level in Meta (not per-campaign), so this is keyed on
-- (clipper_id, ig_username), not per campaign. campaign_id is kept only as
-- admin-facing context for which campaign prompted the request.
CREATE TABLE IF NOT EXISTS tester_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clipper_id INTEGER NOT NULL REFERENCES clippers(id),
  ig_username TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested',   -- requested | invited | confirmed | rejected
  note TEXT,
  campaign_id INTEGER REFERENCES campaigns(id),
  requested_at INTEGER NOT NULL,
  invited_at INTEGER,
  confirmed_at INTEGER,
  UNIQUE(clipper_id, ig_username)
);
CREATE INDEX IF NOT EXISTS idx_tester_clipper ON tester_requests(clipper_id);
CREATE INDEX IF NOT EXISTS idx_tester_status ON tester_requests(status);
