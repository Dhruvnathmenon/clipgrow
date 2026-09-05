-- tester_requests' UNIQUE(clipper_id, ig_username) predates multi-campaign
-- support and has no campaign_id in it. The moment a clipper requests access
-- to a SECOND campaign using the same handle they already used for a first
-- one -- completely normal -- the INSERT collides with their existing row
-- and throws a raw SQLite error. submitAccessRequest() (src/access.js) has
-- no try/catch around that insert, so it surfaces as a bare
-- "Internal server error" instead of either succeeding or a clear message.
--
-- Confirmed against production data before writing this: zero existing rows
-- collide under the corrected key (clipper_id, campaign_id, platform), and
-- campaign_id is never NULL in practice -- this is a clean rebuild, not a
-- data-cleanup migration.
--
-- SQLite has no ALTER TABLE ... DROP CONSTRAINT, so changing a UNIQUE means
-- rebuilding the table: create it correctly, copy every row across
-- untouched, drop the old one, rename the new one into place. Safe under
-- D1's foreign_keys=ON -- nothing holds a foreign key INTO tester_requests,
-- only out of it.
CREATE TABLE tester_requests_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clipper_id INTEGER NOT NULL REFERENCES clippers(id),
  ig_username TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested',
  note TEXT,
  campaign_id INTEGER REFERENCES campaigns(id),
  requested_at INTEGER NOT NULL,
  invited_at INTEGER,
  confirmed_at INTEGER,
  platform TEXT NOT NULL DEFAULT 'instagram',
  identifier TEXT,
  -- The fix: one request per clipper, per campaign, per platform -- not one
  -- per clipper, per handle, ever.
  UNIQUE(clipper_id, campaign_id, platform)
);

INSERT INTO tester_requests_new
  (id, clipper_id, ig_username, status, note, campaign_id, requested_at, invited_at, confirmed_at, platform, identifier)
SELECT id, clipper_id, ig_username, status, note, campaign_id, requested_at, invited_at, confirmed_at, platform, identifier
FROM tester_requests;

DROP TABLE tester_requests;
ALTER TABLE tester_requests_new RENAME TO tester_requests;
