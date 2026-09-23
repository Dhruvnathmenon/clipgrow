# ClipGrow ↔ Clipcore — integration proposal

**For:** Andrig
**From:** Dhruv (ClipGrow website side)
**Date:** 23 Sep 2026

**Status: proposal only. Nothing has been built, and nothing in `clipcore`
has been touched.** Mark this up and send it back before we start.

---

## 0. How to review this

- §6 is the feature list. Put **KEEP**, **CUT**, or **DISCUSS** against each row.
- §7 has three questions. **Question 1 blocks everything** and only you can
  answer it — please answer that one even if you read nothing else.
- Everywhere I propose a constraint, the reason is written next to it. If a
  reason is wrong, say so — the constraint goes with it.
- §8 lists what is explicitly **not** changing, so it's clear what is safe.

---

## 1. What we're actually trying to reach

Right now Discord and the website are two disconnected systems, and a human
(usually staff) is the bridge between them. Four outcomes we want:

1. **One identity per person.** Today the website knows a clipper by
   username/password; Discord knows them by snowflake. Nothing joins the two,
   so nothing personal can ever be automated.
2. **Clippers answer their own questions.** "Am I verified?", "was my video
   approved?", "where's the campaign list?" are currently answerable only by
   a staff member who happens to see the message.
3. **The website can reach people directly.** Approval, rejection, payout —
   pushed to the person instead of waiting for them to check.
4. **The bot is the interface; the website stays the system of record.**

Your flow audit already identified 2 and 3 as the live bottlenecks, so this
is mostly a plan to act on what you found.

---

## 2. The one non-negotiable rule: dependency flows one way

```
  Discord  ──►  Clipcore (Pterodactyl)  ──►  clipgrow.in Worker  ──►  D1
                       (a client)              (system of record)

  Discord  ◄─────────────────────────────────  Worker (REST, queued)
```

- The website **never** calls the bot, never waits on it, has no binding to it.
- The bot holds **no authoritative state**.
- Bot down → Discord loses conveniences. Logins, dashboards, payouts: untouched.

**Why this matters more than usual here:** the website is where people's
unpaid earnings live. If the site's availability ever depended on a bot on a
shared game-hosting node, one bad night on that node becomes "nobody can see
whether they got paid." That is not a risk worth any feature.

**What it means for you concretely:** you never have to build a listener, an
inbound webhook receiver, or anything the website waits on. The bot only ever
makes outbound HTTP calls, on its own schedule, and it is fine if they fail.

---

## 3. A finding that removes work from your side: DMs don't need the bot running

Sending a Discord DM needs only the bot **token** and two REST calls:

1. `POST /users/@me/channels` with `{ recipient_id }` → returns a DM channel
2. `POST /channels/{channel_id}/messages`

Our Cloudflare Worker can make both itself. The gateway connection (the
running bot process) is only needed to *receive* events — mentions, slash
commands, member joins.

**So all outbound notifications are a website feature, not a bot feature.**
You don't build them, and your uptime isn't on the hook for payment notices.

Real constraints we will design around:

- A bot can only DM someone who **shares a guild** with it.
- Users can disable "DMs from server members" — the send just fails.
- Creating many DM channels quickly trips Discord's spam heuristics.

→ A DM is a **nudge, never the record**. The dashboard stays authoritative,
sends are queued and paced, and failures get logged rather than retried blind.

---

## 4. Why nothing valuable should stay on the Pterodactyl box

This isn't a criticism of the setup — it is taking your own findings seriously.

- **Pterodactyl has no native git deployment.** The panel has an open feature
  request for exactly this. So "push to GitHub → server files update" is a
  custom pipeline (a GitHub Action over SFTP, or WingFlow). **We don't know
  what it does to `data/*.json`.** See §7 Q1.
- **Your `pterodactyl-node-issues.md`** already records: Docker Hub
  unreachable, `npm install` crashing in-container, node 2 down, and — the
  one that worries me most — a suspicion that **the bot's own file writes may
  not reliably persist**.
- **`data/referrals.json` holds real money state.** `paidOut` and
  `manualAdjustment` are financial records with no history. If a deploy
  overwrites that file, or a write silently doesn't land, we lose payout
  records and cannot reconstruct them.

**Proposal:** referral data moves into our D1 database, and your existing
`referralPush.js` loop becomes the sync.

**This is not replacing your system.** Same commands, same logic, with a
durable backend and an audit trail instead of a JSON file on a flaky box. You
already wrote the push loop and the payload shape — we just need to build the
endpoint you asked for in `referral-push-api-request.md`.

---

## 5. Why the LLM must never touch live data

This is the constraint most likely to be contentious, so here is the full
reasoning. **The AI helper stays exactly as it is** — this only fences what
it is allowed to reach.

### The rule

| | Path A — docs Q&A (exists) | Path B — personal status (new) |
|---|---|---|
| Trigger | mention, `/helper` | `/mystatus`, routed questions |
| Data it sees | static markdown only | live data, via the Worker |
| LLM involved | yes | **never** |
| Worst-case leak | nothing — it holds nothing | bounded by an allowlist |

### Why

1. **An LLM is not an authorization boundary.** If the model is what decides
   whether to reveal someone's earnings, then a carefully worded message is
   all it takes to get them. Prompt injection beats system prompts reliably,
   and no amount of "never reveal X" wording fixes that.
2. **Discord is a shared, screenshot-able room.** The website is private and
   one-to-one. The same fact is not equally safe in both places.
3. **The bot host is outside our security boundary.** Anything the bot can
   fetch is effectively public if that box is ever compromised.

### What it still allows — natural language keeps working

The LLM may **classify intent**: it sees only the question text, decides
"this is a *my status* question", and hands off. It never sees a number and
never writes a sentence containing one.

```
bot → POST /api/bot/answer  { discord_user_id, intent }
      intent is a CLOSED ENUM — no field names, no queries,
      no "which user" parameter beyond the caller's own id

Worker → { lines: ["⏳ 1 video awaiting review", "✅ Active on 2 campaigns"] }

bot → prints the lines verbatim, ephemeral
```

**The Worker renders the finished text. The bot is a printer.** Unknown
intent → 400. There is no parameter to inject into.

### What the bot can never reach, for anyone, ever

- Another person's anything — earnings, handles, contact details, status
- Campaign budget / spend / remaining, client names, campaign blueprints
- Any admin or client data
- **Staff data, even for real staff.** We cannot verify staff identity through
  the bot — a compromised bot could claim any user has ManageGuild. So staff
  commands return **deep links into the admin panel, never data**.

### Deliberately excluded even though the website shows it

Money figures. A clipper can see their own earnings on their dashboard, but
the bot will not state them. The bot's surface is **strictly smaller** than
the website's, not equal to it. Anything financial is a link.

### If the bot host were fully compromised

Ceiling: enumerate Discord IDs and read coarse status for linked clippers. No
money, no contact details, no client data. Plus a rate limit, an alert on
unusual enumeration, and a rotatable token.

We cannot make a compromised bot harmless. We make it **boring**.

---

## 6. Feature list — mark each KEEP / CUT / DISCUSS

| # | Feature | Side | Why | Your call |
|---|---|---|---|---|
| A | Turn on the live stats voice channels | bot config | Our `/api/public/stats` is already live and already returns `total_paid` / `total_views` — the exact field names `statsChannels.js` reads. **Zero code either side, one env var.** | |
| B | Rewrite `clipgrow-docs.md` + `clipgrow-internal-ops.md` | bot | They still describe staff creating accounts and DMing passwords, plus a Rookie/Editor gate. That flow no longer exists — the site now has video review, then account connect. **The bot is confidently giving wrong answers today.** Biggest effect per minute of work in the whole plan. | |
| C | Discord *connect* required before campaign approval (login stays password-only) | website | **Resolved 2026-09-23 — Andrig's counter-proposal, adopted.** Not OAuth login. Username/password stays the only way in; connecting Discord becomes a mandatory gate before a clipper's application can be approved, exactly like the existing profile-completeness gate. Same win (verified `discord_user_id`, no more free-text `discord_username`) with zero lockout risk — a banned/hacked/deleted Discord never blocks someone from their own account or their own money. | KEEP (revised) |
| D | Outbound DMs + staff channel alerts | website | Video approved/rejected, payout sent, new application waiting, Drive upload failing. Per §3, you don't build this. | |
| E | `/mystatus` | both | Kills the "am I verified?" ping pattern at the source. Coarse status only, ephemeral, money is a link. Needs C first. | |
| F | Live campaign list channel | both | "Where's the campaign list?" is one of the most repeated questions in your own audit. Auto-updating message from our API. | |
| G | Referral data → D1 | both | §4. Your push loop, our endpoint. Removes the money-in-a-JSON-file risk. | |
| H | Guild membership check **+ auto-join** at connect time | website | **Revised per Andrig's request.** Request `identify guilds.join` scopes at connect; if not already a guild member, bot token calls `PUT /guilds/{guild_id}/members/{user_id}` with the user's access token to add them directly — no more manual "go join Discord" step. Safe no-op if already a member. | KEEP (revised) |

### Explicitly proposed NOT to build

| Not building | Why |
|---|---|
| Bot writing anything to the website except referral snapshots | Every write is an attack surface, and the bot host is outside our boundary. |
| Any earnings figure stated in Discord | §5. Screenshot-able room, LLM in the path. |
| Staff/admin commands that return data | We cannot verify staff identity through the bot. Deep links only. |
| Mass DM broadcasts | Trips Discord spam detection and risks the whole app. A channel ping reaches the same people. |
| LLM with tool access to live data | §5. The one thing I would push back on hardest. |

---

## 7. Questions only you can answer

**Q1 — blocking. How does the deploy pipeline treat `data/*.json`?**

If pushing to `clipcore` overwrites files on the server, then every push can
wipe live referral and payout records. Until we know, **nobody should push to
that repo.** If it does overwrite, the fix is to gitignore the data files and
back up the live copies off the node before anything else happens.

**Q2 — Bot token ownership and rotation.**

Who holds the Discord application? The Worker will need the bot token as a
secret in order to send DMs. If the token ever leaks we need to rotate it
without an outage — worth agreeing the process now rather than during an
incident.

**Q3 — Ollama capacity.**

The model runs on the same node as the bot. If `/mystatus` and the campaign
list add traffic, does inference have headroom, or should we keep the
deterministic paths completely off the LLM's queue? (The design already keeps
them separate, but I would like your read on the load.)

---

## 8. What does not change

Nothing below is being removed, rewritten, or taken over:

- The whole `/referral` command set — create, info, list, markpaid, remove,
  adjust, help. Same commands, same behaviour. Only the storage moves (G).
- Invite tracking, `/invites`, `/leaderboard`, the join/leave attribution.
- Role tracking and conversion rates.
- The AI helper, its system prompt, its tone rules, the queue, the retry on
  `[NO_DOC]`, the channel-mention repair. Only its **docs get corrected** (B).
- `/help`, `/ping`, `/uptime`, `/addemoji`, `/server-activity-info`.

---

## 9. Suggested order

Each step ships and reverts on its own.

| Step | What | Why this order |
|---|---|---|
| 0 | Answer Q1; secure `data/*.json` | Everything else risks live money until this is known |
| 1 | A — stats channels on | Zero code. Proves the pipeline end to end |
| 2 | B — fix the docs | Stops active misinformation. Cheapest real win |
| 3 | C + H — Discord login | Unlocks every personal feature; nothing else can start without it |
| 4 | D — DMs and alerts | Website-only, no bot dependency |
| 5 | E + F — `/mystatus`, campaign list | Needs the verified ID from step 3 |
| 6 | G — referrals into D1 | Biggest change to your side; do it once the rest is stable |

Steps 0–2 are cheap and reversible, and they teach us how deploys behave
before we touch anything holding money.

---

## 10. Resolved 2026-09-23 — Discord-first login, or Discord-only?

**Superseded by Andrig's counter-proposal, which we're adopting as-is.**

We originally proposed Discord-**first**: OAuth mandatory for new signups,
existing clippers keep their password, and password becomes an optional
fallback after linking. Andrig's version gets the same result with the
lockout risk fully removed rather than mitigated:

- **Login/signup: unchanged, permanently.** Username + password only. No
  OAuth in that path, ever, for anyone.
- **Discord connect: a separate, mandatory gate.** Connecting Discord
  becomes a required step before a clipper's application/campaign can be
  approved — not a login method, a verification requirement, structurally
  the same as the existing profile-completeness gate.
- Auto-join folded in per Andrig's ask: the connect flow requests
  `identify guilds.join`, and if the person isn't already in the guild, the
  bot adds them directly (`PUT /guilds/{guild_id}/members/{user_id}` with
  their access token) instead of sending them off to join manually.

Why this is better than our original Discord-first proposal, not just
different: a banned, hacked, or deleted Discord account **never** blocks
someone from their own account or their own money, because Discord was
never the door in. It only stalls a *new* campaign approval until
reconnected — a far smaller blast radius. Same verified `discord_user_id`,
same retirement of the free-text `discord_username` field, same working
DMs and `/mystatus`. No emergency exit needed because nothing requires one.
