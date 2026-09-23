-- Back-off between retries needs to know how many times an access request has
-- been rejected and when the last rejection was (see src/backoff.js).
--
-- Video applications already have this: every attempt is its own row with a
-- status and a reviewed_at, so the count and the time are read straight from the
-- rows. tester_requests is one row per clipper+campaign+platform that is reused
-- when the clipper asks again, so the history has to be kept on the row itself.
ALTER TABLE tester_requests ADD COLUMN rejections INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tester_requests ADD COLUMN rejected_at INTEGER;

-- Requests already rejected before this existed count as one, dated when they
-- were asked for, which is long past: nobody is made to wait retroactively.
UPDATE tester_requests SET rejections = 1, rejected_at = requested_at WHERE status = 'rejected';
