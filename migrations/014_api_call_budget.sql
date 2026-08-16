-- Real, per-account tracking of Instagram Graph API call usage.
--
-- Instagram's rate limit is 200 calls/hour PER CONNECTED ACCOUNT, on a
-- ROLLING window -- not a fixed clock-hour reset, and NOT reduced by
-- batching (Meta's own batch-request docs: "Each call within the batch is
-- counted separately"). There is no shortcut around one unit of budget per
-- clip; the only lever is spending that budget deliberately.
--
-- This table is the source of truth for that budget, built from calls we
-- actually made -- not from trusting Instagram's own usage headers, which
-- are not reliably present on every response. One row per real outbound
-- Graph API call (view fetch, media list, media lookup, or token refresh --
-- everything hitting the same per-account limit).
CREATE TABLE IF NOT EXISTS ig_api_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  social_account_id INTEGER NOT NULL REFERENCES social_accounts(id),
  called_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ig_calls_account_time ON ig_api_calls(social_account_id, called_at);
