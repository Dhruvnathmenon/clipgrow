-- Material a clipper works from, kept on the campaign as first-class columns.
--
-- Deliberately NOT in blueprint_json. publicCampaign() feeds the homepage and
-- the SEO pages, and it includes the blueprint, so anything stored there is
-- world-readable. Raw footage links are working material for people who have
-- joined, not something to publish, so they live in their own columns that
-- only the authenticated clipper and admin routes ever select.
--
-- Both hold a JSON array, validated on the way in by src/campaign-sources.js:
--   reference_links  ["https://drive.google.com/...", ...]  public Drive links to
--                    the demo/reference videos (the two used to be separate
--                    ideas; they are one thing)
--   raw_sources      [{"url": "...", "kind": "drive"|"instagram"|..., "label": "..."}]
--                    footage to clip from: a Drive link, or the official pages
--                    on Instagram, YouTube and other platforms
ALTER TABLE campaigns ADD COLUMN reference_links TEXT;
ALTER TABLE campaigns ADD COLUMN raw_sources TEXT;
