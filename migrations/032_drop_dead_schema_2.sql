-- Second pass of dead-schema removal (first was migration 026). Confirmed
-- before writing this, two ways: a database-wide audit dispatched earlier
-- this session, then re-verified column by column just now against the
-- current codebase (a lot changed in between) -- every column below is
-- written nowhere, or written and read back nowhere, in src/*, admin.html,
-- dashboard.html, client-dashboard.html or moderator.html. Every write
-- site that touched one has already been updated in this same change to
-- stop referencing it.
--
-- Deliberately NOT included, despite being unrendered by any UI today:
-- refresh_jobs.error (genuine diagnostic history, exactly the kind of
-- thing this session repeatedly had to hand-query production for) and
-- clippers.created_by_type/created_by_id/created_by_name (real attribution
-- intent, just not yet surfaced) -- "nobody displays this yet" is not the
-- same claim as "this is pointless," and only the latter is being dropped.

-- A five-day termination-notice feature designed into the schema
-- (migration 021) but never built on either the write or the display side.
ALTER TABLE campaigns DROP COLUMN notice_at;
ALTER TABLE campaigns DROP COLUMN notice_ends_at;
ALTER TABLE campaigns DROP COLUMN closed_at;

-- Billing attribution runs entirely through the client_campaigns junction
-- table instead (migration 011) -- this column has never been written by
-- any code path since it was added.
ALTER TABLE campaigns DROP COLUMN client_id;

-- Superseded by refresh-jobs.js's own cooldown/budget logic; not read by
-- any code path.
ALTER TABLE clippers DROP COLUMN last_manual_sync_at;

-- Never written -- migration 021's own comment already called `owner` and
-- `client_id` speculative ("kept so a future per-client wallet stays
-- possible").
ALTER TABLE wallets DROP COLUMN owner;
ALTER TABLE wallets DROP COLUMN client_id;

-- Set once when an access request is invited/confirmed, never read back
-- by any admin surface.
ALTER TABLE tester_requests DROP COLUMN invited_at;
ALTER TABLE tester_requests DROP COLUMN confirmed_at;

-- Set on every status change, never displayed -- status_note (the actual
-- reason shown to admin and clipper) already carries the meaningful part.
ALTER TABLE participations DROP COLUMN status_changed_at;

-- Set on every connect/refresh, never read.
ALTER TABLE social_accounts DROP COLUMN last_checked_at;

-- Set on every import, selected once, never assigned to a response field.
ALTER TABLE submissions DROP COLUMN media_product_type;

-- Set once at job creation; the actual cooldown behavior is driven by
-- pending_json at build time, never by re-reading this flag later.
ALTER TABLE refresh_jobs DROP COLUMN respect_cooldown;
