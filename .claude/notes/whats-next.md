# What's next / open items

Update this as items get resolved — delete finished ones rather than
letting it grow into a full history (that's what changelog.md is for).

## Pending on the founder's side

- **Meta Business Verification** is blocked on: (1) registering ClipGrow
  as a legal business entity — Udyam/MSME registration recommended as the
  fastest path — and (2) a working `support@clipgrow.in` mailbox
  (Cloudflare Email Routing recommended, ~10 min setup). Neither confirmed
  done as of 2026-08-27. See memory `project-clipgrow-verification-status`
  for the full playbook.
- **ranjith and sam** had not completed their one-time YouTube reconnect
  as of 2026-08-27 (the Testing→Production migration on 2026-08-26 forced
  every existing YouTube connection to re-auth once). Worth a nudge if
  still pending — check with:
  `npx wrangler d1 execute clipgrow --remote --command "SELECT cl.username, a.status, a.last_error_code FROM social_accounts a JOIN clippers cl ON cl.id=a.clipper_id WHERE a.platform='youtube'"`

## Recently landed, worth knowing about if it comes up

- The clipper-triggered full refresh button was **removed entirely** on
  2026-08-27 (commit `09922fa`) after confirming the cron itself was
  healthy (6/6 recent runs completed clean) — the button was the source of
  real lock-contention deadlocks, not the sync engine. Clippers now see a
  live countdown to the next automatic sweep instead. Per-clip refresh is
  untouched and is the only thing a clipper triggers now. If asked to
  "bring back the refresh button," read that commit message first — it's a
  deliberate simplification, not an oversight.
