-- A kicked clipper's earnings are meant to freeze at what they had already
-- accrued. The allocator implemented that as min(current earning, remaining
-- budget) -- but `earning` is the PREVIOUS pass's output, so every reallocation
-- took the minimum again. Lowering a campaign's budget wrote the value down,
-- and raising it back never restored it: the clipper permanently lost money the
-- code's own comment says is still owed. frozen_earning stores the amount once,
-- at the moment of kicking, so repricing is idempotent.
ALTER TABLE submissions ADD COLUMN frozen_earning INTEGER;

-- Without this the fix only helps clippers kicked AFTER the deploy: anyone
-- already kicked keeps frozen_earning NULL, the allocator falls back to the
-- previous pass's output, and the ratchet this column exists to remove is still
-- live for exactly that population. Captures what they are worth right now,
-- which is the figure their earnings were meant to have frozen at.
UPDATE submissions SET frozen_earning = earning
 WHERE locked_at IS NULL
   AND frozen_earning IS NULL
   AND EXISTS (
     SELECT 1 FROM participations p
      WHERE p.clipper_id = submissions.clipper_id
        AND p.campaign_id = submissions.campaign_id
        AND p.status = 'kicked');

-- Payments were all one undifferentiated row, so a hand-recorded payment looked
-- identical to one that actually settled videos. Nothing linked it to clips, so
-- those clips stayed payable and were re-ticked on the next payout run -- a
-- straightforward double pay.
--   settlement: created by the payouts flow; locks the clips it covers
--   advance:    money paid up front, owed back out of future settlements
--   bonus:      extra money, never deducted from what the clipper is owed
-- Existing rows are backfilled below rather than defaulted blindly.
ALTER TABLE payments ADD COLUMN kind TEXT NOT NULL DEFAULT 'settlement';

-- Any historical payment that locked clips was a real settlement; anything that
-- locked nothing was hand-recorded, which is what 'advance' now means.
UPDATE payments SET kind = 'advance'
 WHERE COALESCE(clip_count, 0) = 0
   AND id NOT IN (SELECT DISTINCT payment_id FROM submissions WHERE payment_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_payments_kind ON payments(clipper_id, kind);
