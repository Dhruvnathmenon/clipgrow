-- Two pieces of dead schema, confirmed before writing this (2026-09-05):
-- zero rows, zero code references anywhere in src/*, admin.html,
-- dashboard.html or moderator.html.

-- Built (by a different concurrent work session on this repo) but never
-- wired to any route or UI. Dropping it rather than leaving unused schema
-- sitting around implying a feature exists that doesn't.
DROP TABLE IF EXISTS client_invoices;

-- These four columns predate social_accounts (migration 003) -- from when
-- a clipper could only ever connect one Instagram account, stored directly
-- on their own row. Multi-account, multi-platform support superseded them
-- completely.
ALTER TABLE clippers DROP COLUMN ig_username;
ALTER TABLE clippers DROP COLUMN ig_user_id;
ALTER TABLE clippers DROP COLUMN ig_access_token;
ALTER TABLE clippers DROP COLUMN ig_token_expires_at;
