-- Fractional margin: the clipper is paid in complete CPM-multiples of what
-- the client is billed for a clip; whatever's left over (per clip, always
-- less than one CPM unit) becomes the agency's "view margin" -- confirmed
-- explicitly NOT profit taken to pocket, but a reserve for clipper bonuses
-- and campaign promotion spend, so it lands in the same wallet clipper
-- payouts already draw from ('agency' wallet), tagged with its own ledger
-- category (see src/finance.js's LEDGER_CATEGORIES).
--
-- clipper_earning is derived from `earning` (the existing billable amount,
-- unchanged) by src/earnings.js's allocateCampaignEarnings():
--   clipper_earning = FLOOR(earning / campaign.cpm) * campaign.cpm
--
-- Locked clips are NEVER touched by this or any later allocation pass --
-- locked_earning remains the sole, permanent truth for a paid clip. The
-- backfill below is a pure historical-consistency fill for currently-
-- unlocked rows, not a repricing.
ALTER TABLE submissions ADD COLUMN clipper_earning INTEGER;

UPDATE submissions
  SET clipper_earning = (
    SELECT CAST(submissions.earning / campaigns.cpm AS INTEGER) * campaigns.cpm
      FROM campaigns WHERE campaigns.id = submissions.campaign_id AND campaigns.cpm > 0
  )
  WHERE locked_at IS NULL AND earning IS NOT NULL;

-- Campaign lifecycle: a campaign completes automatically the instant its
-- remaining budget can no longer fund even one more full CPM unit for
-- anyone (src/earnings.js). completed_reason distinguishes that automatic,
-- reversible-by-top-up ending from a deliberate manual "Mark Over" (never
-- auto-reopened by budget math alone).
ALTER TABLE campaigns ADD COLUMN completed_reason TEXT;

-- Admin dismissal of the per-clipper "campaign ended" recap card on
-- dashboard.html -- NULL means still showing, set means the founder has
-- cleared it. Campaign-wide, not per-clipper: one action turns it off for
-- everyone once the founder has moved on.
ALTER TABLE campaigns ADD COLUMN recap_hidden_at INTEGER;
