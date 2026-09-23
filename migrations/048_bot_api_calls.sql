-- A short-lived record of calls made to the bot API (src/bot-api.js).
--
-- The Discord bot runs on a host outside ClipGrow's control, so its token is the
-- one credential that could be used to ask about people. It can only ever read
-- coarse, non-financial status (see src/bot-api.js), but a leaked token could
-- still be used to walk through Discord ids. This table is what lets the API
-- notice that: how many calls, and how many DISTINCT people, in the last few
-- minutes. Past a ceiling it refuses for the rest of the window and tells the
-- admin, then clears itself as the window slides.
--
-- subject_hash is a salted hash of the Discord id, never the id, so this table
-- holds nothing that identifies anyone. Rows are pruned after a day.
CREATE TABLE bot_api_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  subject_hash TEXT NOT NULL
);
CREATE INDEX idx_bot_api_calls_ts ON bot_api_calls(ts);
