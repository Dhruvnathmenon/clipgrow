-- One account per email, per phone number, and per Discord username.
--
-- The database holds these unique, so it cannot be got round by two sign-ups
-- landing at the same moment or by a route that forgot to check.
--
-- They are unique on a KEY, not on what was typed. name@gmail.com, n.a.m.e@gmail.com
-- and name+2@gmail.com are one inbox, and +91 98765 43210 and 9876543210 are one
-- phone; comparing the typed text would let anyone make as many accounts as they
-- liked with a trivial change. The keys are computed by emailKey / phoneKey /
-- discordKey in components/profile-validation.js, the same file the sign-up form
-- and the profile form use, so all three agree on what "the same" means.
--
-- Deleted accounts are outside the index: someone who deleted their account can
-- sign up again with the same email, and an archived account does not hold an
-- identity forever. A key stays NULL for anyone with no value, and any number of
-- rows may be NULL.
ALTER TABLE clippers ADD COLUMN email_key TEXT;
ALTER TABLE clippers ADD COLUMN phone_key TEXT;
ALTER TABLE clippers ADD COLUMN discord_key TEXT;

CREATE UNIQUE INDEX idx_clippers_email_key ON clippers(email_key) WHERE email_key IS NOT NULL AND status != 'deleted';
CREATE UNIQUE INDEX idx_clippers_phone_key ON clippers(phone_key) WHERE phone_key IS NOT NULL AND status != 'deleted';
CREATE UNIQUE INDEX idx_clippers_discord_key ON clippers(discord_key) WHERE discord_key IS NOT NULL AND status != 'deleted';
