-- Renamed post-launch after "Agency wallet" / "ClipGrow wallet" proved
-- confusing on the admin Finance tab -- neither name says what the pot
-- actually does. Migration 021's own seed INSERT is left untouched (a
-- migration's history stays as it happened); this is a plain UPDATE so a
-- database that already has these rows gets renamed, and a brand-new
-- database bootstraps through 021 with the old names then immediately
-- lands here with the current ones.
UPDATE wallets SET name = 'Clipper Payout Fund' WHERE kind = 'agency' AND name = 'Agency wallet';
UPDATE wallets SET name = 'ClipGrow Fee Income' WHERE kind = 'clipgrow' AND name = 'ClipGrow wallet';
