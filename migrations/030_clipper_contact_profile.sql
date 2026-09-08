-- A clipper's contact profile: how to reach them and their legal name,
-- alongside the UPI payout details migration 028 already added. Same
-- visibility rule as UPI (see that migration's own comment): admin+clipper
-- only. Never added to publicClipper() (shared with src/routes/moderator.js's
-- roster/detail endpoints and src/routes/client.js's read-only brand
-- portal), so neither a moderator session nor a client login ever sees
-- these -- they're for the founder to actually reach or identify someone,
-- not for staff-wide visibility or a client-facing profile.
ALTER TABLE clippers ADD COLUMN contact_number TEXT;
ALTER TABLE clippers ADD COLUMN email TEXT;
ALTER TABLE clippers ADD COLUMN legal_name TEXT;
-- legal_name deliberately has no validator beyond a trim + length cap (same
-- as upi_account_name) -- there is no fixed shape a real legal name must
-- match. contact_number and email each get a real (lenient) shape check;
-- see validateContactNumber/validateEmail in src/db.js.
