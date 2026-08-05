-- Content/guide pages (SEO): dynamic, admin-managed articles rendered from D1
-- through a Worker route, not static hand-authored files. Each row is one
-- page targeting one specific real search query -- see admin.html's Guides
-- tab for the management UI.
CREATE TABLE IF NOT EXISTS guides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  meta_description TEXT,
  audience TEXT NOT NULL DEFAULT 'clipper',   -- clipper | brand
  target_keyword TEXT,
  body_html TEXT NOT NULL,                    -- founder-authored via admin, not user input
  status TEXT NOT NULL DEFAULT 'draft',        -- draft | published
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_guides_status ON guides(status);
