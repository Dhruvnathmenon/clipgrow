-- Minimum views a clip must reach before it earns anything. Below this it is
-- tracked and displayed but pays zero; once it crosses, it earns on its FULL
-- view count at the campaign CPM (not just the excess above the threshold).
-- Per-campaign so it can be tuned later; 1,000 is the house default.
ALTER TABLE campaigns ADD COLUMN min_views INTEGER NOT NULL DEFAULT 1000;
