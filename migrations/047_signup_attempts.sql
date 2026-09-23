-- Self-serve clipper sign-up needs a brake, because it is the first place ClipGrow
-- lets an anonymous visitor create a row. One row per account created, keyed by a
-- salted hash of the caller's IP (never the address itself), so a per-address and
-- a site-wide limit can both be checked with a plain COUNT.
--
-- Only completed sign-ups are recorded: a rejected username or a weak password
-- costs almost nothing to check, whereas a completed one is what hashes a password
-- and writes a row. Rows older than two days are pruned as new ones are written,
-- so the table stays a few hundred rows at most.
CREATE TABLE signup_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_signup_attempts_ip ON signup_attempts(ip_hash, created_at);
CREATE INDEX idx_signup_attempts_time ON signup_attempts(created_at);
