-- Clip preview images. thumbnail_key points at an object in R2 (permanent).
-- thumbnail_url is the raw Instagram CDN URL, kept as a fallback for when R2
-- is not enabled yet -- those URLs are signed and expire, so R2 is preferred.
ALTER TABLE submissions ADD COLUMN thumbnail_key TEXT;
ALTER TABLE submissions ADD COLUMN thumbnail_url TEXT;
ALTER TABLE submissions ADD COLUMN media_product_type TEXT;
ALTER TABLE submissions ADD COLUMN posted_at INTEGER;
