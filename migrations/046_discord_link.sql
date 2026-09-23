-- A clipper's verified Discord identity.
--
-- discord_username (migration 035/039) is free text the clipper types: it can be
-- wrong, can change, and proves nothing. These columns are filled ONLY by the
-- Discord OAuth callback (src/routes/discord-auth.js), from the identity Discord
-- itself returns for someone who is signed in to ClipGrow -- never from a form.
--
--   discord_user_id    Discord's permanent snowflake id. The stable key: handles
--                      change, this does not. Everything that talks to a person
--                      on Discord (DMs, /mystatus, roles) is keyed on this.
--   discord_handle     the @username at the moment they linked, for display only.
--   discord_linked_at  when they linked.
--
-- UNIQUE, so one Discord account can back only one ClipGrow account. That is
-- what makes "one account per person" enforceable rather than a policy: a second
-- account cannot pass the Discord step with an identity already in use.
ALTER TABLE clippers ADD COLUMN discord_user_id TEXT;
ALTER TABLE clippers ADD COLUMN discord_handle TEXT;
ALTER TABLE clippers ADD COLUMN discord_linked_at INTEGER;
CREATE UNIQUE INDEX idx_clippers_discord_user_id ON clippers(discord_user_id) WHERE discord_user_id IS NOT NULL;
