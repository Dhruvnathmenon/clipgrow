-- Manual "refresh views" button on the clipper dashboard.
-- Stored per clipper so the cooldown survives restarts and can't be bypassed
-- by clearing browser state.
ALTER TABLE clippers ADD COLUMN last_manual_sync_at INTEGER;
