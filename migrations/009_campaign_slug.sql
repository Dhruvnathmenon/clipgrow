-- URL-friendly slug per campaign, backing the public /campaigns/:slug page
-- (SEO: gives each campaign a real, indexable, permanent URL instead of only
-- existing as a client-fetched tile on the homepage).
-- Nullable with a partial unique index so existing rows don't need a backfill
-- migration to satisfy a NOT NULL constraint -- new campaigns get one at
-- creation time; old ones are backfilled once via a manual UPDATE.
ALTER TABLE campaigns ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_slug ON campaigns(slug) WHERE slug IS NOT NULL;
