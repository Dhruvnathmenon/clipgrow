-- Reverts the fractional-margin split back to plain billable pay, per the
-- founder's explicit request (8 Sep 2026) -- the code side is reverted in
-- the same commit as this migration (src/earnings.js no longer floors
-- clipper_earning to a CPM multiple; it now always matches `earning`).
--
-- This is a data-only fix, no schema change: the 031 backfill and every
-- allocation pass since then wrote a FLOORED clipper_earning for unlocked
-- submissions. Without this, those rows would keep showing the old,
-- lower figure until the next natural refresh/allocation pass happened to
-- touch them -- this brings every currently-unlocked row in line with the
-- reverted logic immediately instead of waiting on that.
--
-- Locked clips are, as always, never touched -- locked_earning remains the
-- sole, permanent truth for a paid clip (CLAUDE.md's one rule).
UPDATE submissions
  SET clipper_earning = earning
  WHERE locked_at IS NULL;
