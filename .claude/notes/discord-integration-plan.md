# Discord ↔ ClipGrow integration — plan (not yet built)

Written 2026-09-21. Nothing in here is implemented. Supersedes the Discord
half of `~/.claude/plans/nifty-noodling-journal.md`, which assumed the bot
did not exist yet — it does, and it is Andrig's `Endrig7/clipcore`.

## 1. The host: what Pterodactyl actually is

- Open-source **game server** panel. Two parts: **Panel** (PHP/React UI +
  REST API — users, servers, config) and **Wings** (Go daemon on each
  physical node, drives Docker).
- Each "server" is **one Docker container on one node**. No redundancy, no
  failover, no multi-region. Resource caps come from Docker.
- Files: **SFTP** + a web file manager. Env vars and the startup command are
  injected from the **Egg** (a server template).
- **There is no native git deployment.** Pterodactyl has an open feature
  request for exactly this. So "push to GitHub → files update on the server"
  is a *custom pipeline* someone set up — almost certainly a GitHub Action
  that SFTPs the repo over, or WingFlow.
  - **Must verify:** does that pipeline overwrite `data/*.json`? If yes,
    every push can destroy live referral/payout records. See §5 Phase 0.
- The node is already known-flaky. `clipcore/pterodactyl-node-issues.md`
  (Andrig's own write-up) records Docker Hub unreachable, `npm install`
  crashing in-container, node 2 down, and a suspicion that **the bot's own
  file writes may not persist**.

**Conclusion: this host is fine for a chat bot and unfit to hold anything
we cannot afford to lose.** That single fact drives the whole architecture
below, and it independently confirms the founder's instinct.

## 2. The one rule: dependency flows one way

```
   Discord  ──►  clipcore (Pterodactyl)  ──►  clipgrow.in Worker  ──►  D1
                        (client)                (system of record)
   Discord  ◄──────────────────────────────────  Worker (REST, queued)
```

- The Worker **never** calls the bot, never waits on it, has no bot binding.
- The bot holds **no authoritative state** — it renders and it remotes.
- Bot dies → Discord loses conveniences. Website, logins, payouts: untouched.

### The insight that removes most of the risk

**Sending a Discord DM does not require the bot to be running.** A DM needs
only the bot *token* and two REST calls, which a Cloudflare Worker can make
itself:

1. `POST /users/@me/channels` with `{ recipient_id }` → a DM channel
2. `POST /channels/{id}/messages`

The running bot process (the gateway connection) is only needed to *receive*
events — slash commands, mentions, member joins. So every outbound
notification (video approved, payout sent, staff alert) is a **website**
feature that keeps working while the bot is down.

Constraints on DMs, which make them best-effort and never authoritative:
- A bot can only DM someone who **shares a guild** with it.
- Users can turn off "DMs from server members" — the send then fails.
- Creating many DM channels quickly trips Discord's spam heuristics.

→ Therefore: DM = a nudge. The dashboard remains the source of truth, every
send is queued and paced, and every failure is logged (never retried blind).

### Where the Worker must not couple

Outbound Discord calls go through **Cloudflare Queues**, never inline in a
request handler. Inline would mean Discord's latency becomes ClipGrow's
latency — reintroducing, by accident, the exact coupling we are avoiding.

## 3. Login: resolved — password stays, Discord becomes a mandatory verification gate

**Superseded by Andrig's 2026-09-23 reply.** The Discord-first proposal
below (OAuth as login, password as break-glass) is kept for the record, but
Andrig proposed a better version of the same goal and it's what we're
building.

### The agreed design

- **Login/signup: unchanged.** Username + password only. No OAuth in the
  login path, no auto-provisioning at login, no password ever made optional.
- **Discord connect: a new mandatory gate**, structurally identical to the
  existing profile-completeness gate (`needsProfile()`,
  `src/routes/clipper.js:117`, enforced at `clipper.js:385,410,461,534`) and
  to the existing Step 1 → Step 2 video-review gate (`applicationState`,
  `canConnect`, `src/access.js:200`).
  - A clipper must have a **verified, guild-checked** `discord_user_id` on
    file before an application can be approved / before Step 2 opens for
    that campaign — exact insertion point (submission-time vs
    approval-time) to be decided at build time, following the same pattern
    `needsProfile()` already uses.
  - The link itself happens the same way Instagram/YouTube connect already
    works: OAuth *inside an authenticated clipper session*, never as a way
    to obtain a session. `src/auth.js` genuinely needs zero changes now —
    even less than the original proposal, since there's no new login path.

### Why this is strictly better than Discord-first

Same outcome (verified `discord_user_id`, `discord_username` free-text field
retired as a source of truth, one-account-per-person enforceable, DMs and
`/mystatus` all work) with the lockout risk **fully removed** rather than
mitigated:

- A clipper whose Discord is hacked, banned, or deleted still has their
  password and their account, and still sees what they're owed. There's no
  "break-glass" needed because the break-glass *is* the only path in.
- A Discord outage degrades nothing about logging in — only new campaign
  approvals stall until it's back, which is a far smaller blast radius than
  "nobody can check if they were paid."
- The referral-pays-cash-per-invite ToS-grey-zone risk (§ unchanged) no
  longer threatens login at all, only new campaign approvals.

### Effect on H (guild membership check)

Andrig asked: instead of just checking membership, can we **auto-add**
someone to the guild during connect, via the `guilds.join` OAuth scope,
rather than making "go join Discord manually" a separate step?

Yes — this is a real Discord mechanism, and it fits the same connect flow
with no architectural change:

1. OAuth authorize with scopes `identify guilds.join`.
2. Exchange the code for the user's own access token (short-lived, ours to
   hold only long enough for step 3).
3. Bot token calls `PUT /guilds/{guild_id}/members/{user_id}` with
   `{ access_token: <the user's token from step 2> }` in the body. The bot
   must already be a member of the guild with permission to add members —
   true today, no new bot permission needed.
4. If the person is already in the guild, this call is a harmless no-op —
   so it's safe to always attempt it rather than branching on membership
   first.

This makes H strictly nicer (one fewer manual step for the clipper) and
doesn't change E or F at all — both still just need the verified
`discord_user_id` this gate produces, regardless of how membership was
reached.

### What this changes about the earlier "Discord-first" text below

Nothing below this point should be read as current — kept only so the
reasoning trail (why Discord-only was rejected) isn't lost, since most of
that reasoning (lockout, outage, ToS grey zone) is exactly what motivated
Andrig's version too, just resolved more completely.

---
## 3. Login: can we go fully Discord-only?

**Possible: yes, easily.** OAuth2 authorization-code flow, entirely
server-side in the Worker, same start/callback shape already proven twice
here (`instagram-auth.js`, `youtube-auth.js`). `src/auth.js` needs no change
— sessions are already role-agnostic.

**Helpful: yes, strongly** — but as the *front door*, not as the only door.

### Why Discord login is worth doing

1. Kills the manual "staff creates the account and DMs credentials" step —
   the single most repeated support question in Andrig's own flow audit.
2. Makes "one account per person" technically enforceable instead of a
   policy nobody can police.
3. Gives a **verified `discord_user_id`**. Today's `discord_username` is
   free text (42 of 69 filled, unverified, user-changeable) — unusable as a
   key. Without a verified id there are no DMs, no `/mystatus`, no role
   sync, no referral attribution.
4. Guild membership becomes server-side checkable (`GET
   /guilds/{guild_id}/members/{user_id}` with the bot token), so "you must
   be in our Discord" stops being honour-system.

### Why Discord-*only* is the wrong call

- **Lockout = unpaid money.** A clipper whose Discord is hacked, banned, or
  deleted loses access to earnings we owe them, with no path back except
  manual staff work — the exact manual work this is meant to delete.
- **Third-party single point of failure.** Discord outage → nobody can log
  in, including to check whether they were paid. We have no SLA with
  Discord and pay them nothing.
- **Platform risk is real here, not theoretical.** The referral system pays
  cash per invite (`/referral create … pay:₹/join`). Incentivized invites sit
  in a grey zone under Discord's ToS. If the guild or app is ever actioned
  and login *is* Discord, the business goes dark in one step.
- The benefit of deleting passwords is a little less code. The cost is
  losing the emergency exit. Bad trade.

### Recommendation: Discord-first, password as break-glass

- **New signups:** Discord OAuth only. No password form anywhere.
- **Existing 69:** keep their password, untouched. Dashboard prompt to link
  Discord.
- **After linking:** a clipper may optionally set a password as a fallback.
- **Never auto-match on `discord_username`** — changeable and unverified; a
  collision would hand one person's earnings to another. Linking only ever
  happens inside an already-authenticated session.

This delivers 100% of the stated goal (everyone signs in with Discord,
one identity, no manual provisioning, DMs work) and keeps the exit.

## 4. Data access — the bot is narrower than the website, not equal to it

### The rule that is wrong, and the one that replaces it

Tempting rule: *"the bot shows a clipper exactly what their own dashboard
shows."* Rejected. Discord is a shared, screenshot-able room, an LLM sits in
the path, and the host is untrusted. So:

> **Bot surface ⊂ the clipper's own dashboard surface.** Strictly smaller.
> Money figures and campaign budgets are excluded even though the website
> shows them to that same person.

### Two paths that must never meet

| | Path A — docs Q&A | Path B — personal status |
|---|---|---|
| Trigger | mention / `/helper` | `/mystatus`, routed intents |
| Data | static markdown only | live D1, via Worker |
| LLM | yes | **never** |
| Leak risk | nil (holds nothing) | bounded by allowlist |

**The LLM never touches live data.** It may *classify intent* (it sees only
the question text) but it never sees a number and never composes an answer
containing one. An LLM is not an authorization boundary and must never be
placed in one.

### Request shape

```
bot → POST /api/bot/answer
      { discord_user_id, intent }        intent ∈ closed enum
Worker → { lines: ["⏳ 1 video awaiting review", …] }
bot → prints verbatim, ephemeral
```

- `intent` is a **closed enum**. No field selectors, no queries, no "which
  user" parameter beyond the caller's own Discord id. Unknown intent → 400.
  There is no surface to inject into.
- The Worker **renders the final display strings**. The bot is a printer.
- Reuse the existing allowlist-projection pattern from
  `src/routes/public.js:21` (`publicListItem`) — explicitly named safe
  fields, never a spread of an internal object.

### Never reachable through the bot, by anyone, for any reason

- Another person's anything — earnings, handles, contact details, status.
- Campaign `budget` / `spent` / `remaining`, client names, blueprint/CTA.
- Any admin or client data.
- **Staff commands return deep links only, never data.** The Worker cannot
  verify staff identity through the bot — a compromised bot can claim any
  Discord user has ManageGuild. So staff privilege is never honoured
  server-side on a bot-originated request.

### Blast radius if the bot host is fully compromised

Attacker can enumerate `discord_user_id`s and read coarse status for linked
clippers. That is the ceiling, by design — no money, no contact details, no
client data. Controls:
- Per-token rate limit + distinct-user anomaly alert → `error_log`, auto-disable.
- Token rotatable via `wrangler secret put` with no bot code change.
- We cannot make a compromised bot harmless. We make it **boring**.

### Website finding, separate from the bot

`src/routes/clipper.js:356` spreads `publicCampaign(...)`, so logged-in
clippers currently **do** see `budget`, `spent` and `remaining`. If deal size
is considered internal, that is a website change in its own right — decide
it separately from the bot work.

## 5. Build order — each phase shippable and revertible alone

**Phase 0 — Stop the bleeding (do first, before any push to clipcore)**
- Confirm how the deploy pipeline treats `data/*.json`.
- If it overwrites: `.gitignore` the data files, back up live copies off the
  node, confirm the bot recreates them cleanly.
- Risk addressed: a routine push wiping real payout records.

**Phase 1 — Stats channels on.** Zero code either side. Our live
`/api/public/stats` already returns `total_paid` / `total_views`, the exact
field names `statsChannels.js` reads. Set `STATS_API_URL` in Pterodactyl.

**Phase 2 — Rewrite the bot's knowledge docs.** `data/clipgrow-internal-ops.md`
still describes staff-created accounts, DM'd passwords, and a Rookie/Editor
gate. That flow is gone. The bot is confidently misinforming people today.
One markdown file; biggest effect per minute of work in the whole plan.

**Phase 3 — Discord OAuth login.** New `src/routes/discord-auth.js`,
migration `046` adding `clippers.discord_user_id TEXT UNIQUE` (nullable),
guild-membership check, auto-provision on first login, link flow for the
existing 69.

**Phase 4 — Outbound notifications.** Worker → Discord REST via Queues:
video approved/rejected DM, payout-sent DM, staff channel alert on new
application and on Drive failure. Delivery failures land in `error_log`;
admin gets a "Check Discord" panel mirroring the existing Drive one.

**Phase 5 — `/mystatus` + live campaign list.** Needs Phase 3's verified id.
Replies ephemeral, coarse status only, deep link for anything financial.

**Phase 6 — Referrals into D1.** Receiving endpoint + migration; the bot's
existing 5-minute push loop becomes the sync. Money leaves the flaky node.

## 6. Failure matrix

| Failure | Effect on website | Mitigation |
|---|---|---|
| Bot process down | none | DMs still sent by Worker; channel names hold last value |
| Pterodactyl node dies | none | nothing authoritative lives there after Phase 6 |
| Discord API down | login degraded for Discord-only users | password fallback; queued DMs retry |
| Discord bans guild/app | login degraded | password fallback is the whole reason it exists |
| Bot token leaked | read-only, no money exposed | rotate; scope kept coarse by design |
| Deploy overwrites bot data | none after Phase 0/6 | data ignored in git, authoritative in D1 |
| User has DMs closed | none | dashboard authoritative; failure logged |

## 6b. Build log (updated as phases ship)

**Phase 3a - Discord connect (built, checkpoint 14).** `migrations/046`,
`src/discord.js`, `src/routes/discord-auth.js`, gate in `clipper.js`
(`needsDiscord`, beside `needsProfile`) and `canConnect`. Admin "Check Discord"
panel. Discord linking is **login-independent**: OAuth runs inside an
authenticated session and never creates one.

- **Rollout valve, added after finding the four `DISCORD_*` secrets already on
  production** (left from an earlier attempt). Enforcing on their mere presence
  would have stopped every clipper joining/applying/connecting the moment this
  deployed. `DISCORD_LINK` in `wrangler.jsonc` is `off` -> `optional` ->
  `required`, one committed step at a time. Ships as `off`.
- Rotating the Discord bot token on Andrig's side now ALSO means
  `wrangler secret put DISCORD_BOT_TOKEN` here, or auto-join stops working
  (Check Discord shows it immediately).
- Needs, from the Discord app owner: the redirect
  `https://clipgrow.in/api/auth/discord/callback` registered under
  OAuth2 > Redirects, and the bot allowed to create invites (auto-join).

**Phase 3b - Self-serve signup (built, checkpoint 15; ships CLOSED).**
`CLIPPER_SIGNUP` in `wrangler.jsonc` is `off` | `open`. `POST /api/clipper/signup`
(`clipper.js`), rules in `components/account-validation.js` (shared with the login
page), brake in `src/signup.js` + migration 047 (6/hour and 15/day per hashed
address, 200/hour site-wide, checked BEFORE the password is hashed; honeypot field).
Open it only after `DISCORD_LINK` is at least `optional`. Original finding, while re-reading
Andrig's `verification-process-proposal.md`: accounts are still created only by
an admin (`src/routes/admin.js`, `POST /api/admin/clippers`). Needed:
`POST /api/clipper/signup` (clipper picks username + password), with per-IP
rate limiting, username/password rules, and the Discord gate (one Discord =
one account) as the duplicate-account backstop. Andrig's ticket-based review and
"auth code" idea are deliberately NOT adopted: the website review already
exists, is tested, and unlocks Step 2 automatically.

## 7. Open decisions (blocking Phase 3+)

1. Discord-first vs Discord-only — recommendation above is Discord-first.
2. Deploy pipeline behaviour toward `data/*.json` — unverified.
3. DM scope: transactional only, or broadcasts too? Broadcasts carry
   spam-flag risk and should prefer a channel ping over mass DM.
