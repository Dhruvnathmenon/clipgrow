-- Distinguishes clips auto-imported from a connected account's feed from ones
-- a clipper pasted in by hand. Auto-import only ever picks up media posted
-- AFTER the account was connected; older back-catalogue clips still come in
-- via the paste-a-link flow, so the admin can tell the two apart.
ALTER TABLE submissions ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
