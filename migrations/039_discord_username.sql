-- Discord's numeric User ID (migration 035) required Developer Mode + a
-- right-click to copy -- too much friction for clippers to actually fill
-- in. Their @username is always visible, no setup needed. Trades away the
-- one-click "open a DM directly" link (only the numeric ID can build that
-- URL -- a username genuinely cannot), in exchange for people actually
-- filling the field in. src/db.js's normaliseDiscordUsername/
-- validateDiscordUsername replace the old ID-shaped validator.
--
-- Existing values are wiped, not carried over: a numeric ID has no usable
-- relationship to a username, and re-collecting from every clipper is the
-- only correct path.
ALTER TABLE clippers RENAME COLUMN discord_id TO discord_username;
UPDATE clippers SET discord_username = NULL;
