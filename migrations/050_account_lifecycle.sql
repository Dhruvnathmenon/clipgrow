-- Clearing out accounts that were made and never used, and letting anyone delete
-- their own. See src/account-lifecycle.js.
--
--   last_seen_at        when the clipper last used the dashboard (written at most
--                       once every few hours, not on every request).
--   dormant_warned_at   when we told them the account was about to be removed.
--   dormant_warned_via  where the warning actually landed ('discord'). Empty means
--                       no warning reached them, and an account nobody could warn
--                       is never deleted for being unused.
--   dormant_exempt      1 = an admin said keep this one (a tester, a friend of the
--                       team); the clean-up never touches it.
--   deleted_at / deleted_reason  who ended the account: 'self', 'inactive', 'admin'.
ALTER TABLE clippers ADD COLUMN last_seen_at INTEGER;
ALTER TABLE clippers ADD COLUMN dormant_warned_at INTEGER;
ALTER TABLE clippers ADD COLUMN dormant_warned_via TEXT;
ALTER TABLE clippers ADD COLUMN dormant_exempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clippers ADD COLUMN deleted_at INTEGER;
ALTER TABLE clippers ADD COLUMN deleted_reason TEXT;

-- Every clock starts now. Nobody who already has an account is treated as unused
-- because of a day they logged in before this column existed: the earliest an
-- existing account can be warned is a full inactivity period from today, and
-- earliest it can be deleted is the grace period after that.
UPDATE clippers SET last_seen_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE status != 'deleted';

-- Accounts an admin archived before this existed.
UPDATE clippers SET deleted_reason = 'admin' WHERE status = 'deleted';
