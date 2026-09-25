# Bot ↔ website integration docs

Three contracts, all **website → bot**, all served by the same listener on the
bot (one port, one shared bearer token — nothing new to configure between
them). Start with whichever matches what you're building next; each links to
the others.

| Doc | What it's for |
|---|---|
| [`bot-notify-contract.md`](./bot-notify-contract.md) | DM a clipper when a clip is approved/rejected or a payout is sent (`POST /notify`) |
| [`bot-link-contract.md`](./bot-link-contract.md) | "Connect to Discord" on the dashboard — get their Discord id and auto-join them to the server (`POST /link`) |
| [`bot-campaign-forum-contract.md`](./bot-campaign-forum-contract.md) | Auto-post/update one forum thread per campaign, replacing hand-written posts (`POST /campaign-sync`, plus extending `GET /api/bot/campaigns`) |

## What you need from us

- The listener's host/port and the bearer token (`NOTIFY_WEBHOOK_PORT` /
  `NOTIFY_WEBHOOK_TOKEN` on the bot's side) — shared out of band, not in these
  docs.
- Nothing else — no SDK, no library. Every call is a plain `POST` with a JSON
  body and an `Authorization: Bearer <token>` header, and every response is
  plain JSON. `curl`/`fetch` is enough to test any of them by hand.

## What we need from you

- **`bot-link-contract.md`**: nothing new — this is entirely the OAuth flow on
  your side, ending in one call to us.
- **`bot-campaign-forum-contract.md`**: extend `GET /api/bot/campaigns` with
  the fields in that doc's table (`status`, `budget_total`, `clippers_enrolled`,
  etc.), and call `POST /campaign-sync` after any campaign create/edit. One
  field genuinely doesn't exist on your side yet and needs adding:
  **`logo_url`** (the campaign/brand logo).
- **`bot-notify-contract.md`**: call `POST /notify` whenever a clip is
  approved/rejected or a payout goes out — no new fields needed on your side,
  just the call.

## If you're an AI assistant implementing this

Dhruv (this website's developer) gave you these docs because he wants this
integration built on the website side. **Before writing any code, ask him the
questions below** — this doc only defines the bot's side of the contract, it
has no visibility into this codebase, so guessing at the answers risks building
against the wrong table name, the wrong auth pattern, or the wrong file, which
means redoing it:

1. **Where are campaigns created/edited in this codebase?** (DB table or model,
   the route/controller that handles it) — needed to know where to add the new
   fields and where to trigger `POST /campaign-sync`.
2. **What database/ORM does this project use**, and what's the right way here
   to add new columns (`status`, `budget_total`, `budget_consumed`,
   `clippers_enrolled`, `max_payout_per_video`, `logo_url`, `emoji`, `cta`,
   `dos`, `donts`, etc. — see `bot-campaign-forum-contract.md`)?
3. **What's the exact field name already storing a clipper's Discord user id?**
   (referenced as already existing, used by `/mystatus` and referral linking —
   confirm the real name rather than assuming `discord_user_id`.)
4. **What HTTP client does this codebase already use** for outbound calls
   (`fetch`, `axios`, `got`, something else)? Match the existing convention
   instead of introducing a new dependency.
5. **What's the convention for env vars / secrets in this project** (a `.env`
   file, a secrets manager, something else)? That's where
   `NOTIFY_WEBHOOK_PORT`, `NOTIFY_WEBHOOK_TOKEN`, and the bot's host belong —
   see the note below.
6. **Does this codebase already have any OAuth2 flow implemented** (even for
   something unrelated, like Google login)? If so, reuse that pattern for the
   Discord "Connect" flow in `bot-link-contract.md` instead of building one
   from scratch.
7. **Who/what actually updates a campaign's budget/clipper count as events
   happen** — a cron job, a queue worker, an admin action? That's where the
   `POST /campaign-sync` call for "anything changed" needs to be wired in, and
   it may not be the same place as campaign creation.

**Never invent, guess, or hardcode `NOTIFY_WEBHOOK_PORT` or
`NOTIFY_WEBHOOK_TOKEN`.** Dhruv doesn't have these values either yet — he needs
to ask the bot's maintainer for them. Wire the code to read them from env vars
under whatever name/convention this project already uses, and clearly flag
that the actual values still need to be filled in before this can go live.

## Everything else worth knowing

- Every payload validates independently — a bad request never crashes the bot,
  you just get a `400` with a `message` saying exactly what's wrong.
- Nothing here is ever destructive from your side: the bot never deletes a
  thread or a message based on what you send it, and duplicate calls (retries,
  double-fires) are safe — `/notify` dedupes by `event_id`, `/link` no-ops if
  already a member, `/campaign-sync` just re-syncs from the current state.
