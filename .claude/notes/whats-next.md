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
## Recently landed, worth knowing about if it comes up

- **ranjith and sam's YouTube reconnect** (was pending as of 2026-08-27) is
  done — both show `status: connected` as of 2026-09-08.
- The fractional-margin clipper-payout split (Plan B, shipped 2026-09-07/08)
  was **reverted** on 2026-09-08 at the founder's request — clippers are
  paid the full billable amount again, campaigns no longer auto-complete on
  budget exhaustion. The schema/columns and everything else from that work
  (contact profile, top-up, recap card, dead-column cleanup) stayed. See
  commit `0a6da71` and its message for the full scope. The admin Finance
  tab's vestigial "View Margin" panel (would always have read ₹0 since
  nothing generates margin anymore) was removed the same day.

- The clipper-triggered full refresh button was **removed entirely** on
  2026-08-27 (commit `09922fa`) after confirming the cron itself was
  healthy (6/6 recent runs completed clean) — the button was the source of
  real lock-contention deadlocks, not the sync engine. Clippers now see a
  live countdown to the next automatic sweep instead. Per-clip refresh is
  untouched and is the only thing a clipper triggers now. If asked to
  "bring back the refresh button," read that commit message first — it's a
  deliberate simplification, not an oversight.
