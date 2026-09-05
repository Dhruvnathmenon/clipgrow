-- Payout details a clipper enters themselves, so the admin can pay them
-- directly by UPI without contacting them for it on every payout run.
--
-- Deliberately admin-only to read: never added to publicClipper() (shared
-- by src/routes/moderator.js's roster/detail endpoints), so a moderator
-- session can never see it, and never touched by src/routes/client.js
-- (the read-only brand portal, which already keeps every clipper-money
-- field out of a client's reach by construction).
ALTER TABLE clippers ADD COLUMN upi_id TEXT;
ALTER TABLE clippers ADD COLUMN upi_account_name TEXT;
