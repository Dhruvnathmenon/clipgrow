-- Lets an admin tell the dashboard "I've looked at this, it's not a
-- problem" for a specific flagged social_accounts issue -- without that
-- silently hiding a genuinely NEW problem later.
--
-- Two false-positive shapes prompted this:
--   1. A clipper renames their handle, then reconnects. The OAuth callback
--      overwrites `username` with the new name against the SAME account
--      (external_id unchanged), and the mismatch check (which only ever
--      compares tester_requests.identifier to the current username) flags
--      it exactly like a genuine wrong-account swap would.
--   2. `needs_reauth` is set from ANY auth failure -- an intentional
--      revoke from the clipper's own Instagram/Google settings looks
--      identical to a token that broke for an unrelated reason. There is
--      no way today to tell them apart.
--
-- Neither column is a plain "dismissed forever" boolean. Each stores what
-- was true AT THE MOMENT of acknowledgment, so the flag stays suppressed
-- only while nothing has actually changed since -- and reappears on its
-- own the moment a real new issue occurs. No code elsewhere has to know
-- this exists.
ALTER TABLE social_accounts ADD COLUMN mismatch_acknowledged_as TEXT;
-- Suppresses the mismatch badge while social_accounts.username still
-- equals this value. A later reconnect that changes username again no
-- longer matches -- the badge returns without anyone re-flagging it.

ALTER TABLE social_accounts ADD COLUMN error_acknowledged_at INTEGER;
-- Suppresses needs_reauth / import-failing while last_error_at predates
-- this timestamp. A fresh failure after the ack moves last_error_at
-- forward past it, so the badge returns automatically.
