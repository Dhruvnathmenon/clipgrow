-- A second, optional contact channel alongside contact_number (migration
-- 030) -- when a clipper hasn't filled in WhatsApp, or doesn't answer
-- there, Discord is the fallback. Stores the numeric Discord User ID (the
-- "snowflake" from Copy User ID with Developer Mode on), not a username --
-- only the numeric ID can build a working profile/DM link
-- (admin.html's discordLink()); a username cannot.
ALTER TABLE clippers ADD COLUMN discord_id TEXT;
