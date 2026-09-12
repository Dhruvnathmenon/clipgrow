-- "Total Views Generated" is a lifetime, monotonic number the agency shows
-- off publicly (tracker.html, admin.html's hero stat) -- it must never go
-- down. It always used to be a live SUM(views) FROM submissions, which is
-- fine right up until a submission row is deleted (disconnect freeing an
-- unpaid clip's budget, or an admin manually deleting a clip) -- at that
-- point its views simply vanish from the sum, and a real, previously-shown
-- number quietly shrinks. This table is where a deleted clip's views go
-- instead of nowhere, so the lifetime total can add them back in.
CREATE TABLE IF NOT EXISTS retired_view_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  views INTEGER NOT NULL,
  submission_count INTEGER NOT NULL,
  reason TEXT NOT NULL,        -- 'disconnect' | 'admin_delete'
  clipper_id INTEGER,
  account_id INTEGER,
  created_at INTEGER NOT NULL
);
