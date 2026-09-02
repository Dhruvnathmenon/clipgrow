# ClipGrow Discord Bot — Build Spec

**For:** Endrig (Discord bot build), working with Dhruv.
**Companion doc:** *ClipGrow Agency Operating System* (PDF — `ClipGrow-Agency-System.pdf`,
shared separately) — the full operational picture (the ladder, ranks, flows,
money model). Read that first; this spec assumes it.
**Status:** ready to build. Hosting model is Endrig's call (§4). The ClipGrow-side
API (§10) does not exist yet — it's specified here so both halves are built to the
same contract.

> **Note for Endrig's Claude Code session:** you have no prior memory of ClipGrow.
> The ClipGrow website was built in a different repo by Dhruv's Claude sessions;
> that context does not transfer just because it's the same Anthropic account.
> **§2 of this document is your briefing on ClipGrow.** Treat it as authoritative.
> If anything here conflicts with what you find in the actual `clipgrow` repo,
> the repo wins — ask Dhruv to confirm.

---

## 1. What the bot is — and isn't

The bot exists to do the **one thing off-the-shelf Discord tools can't**: keep
Discord roles and the ClipGrow website in lockstep. Every rank change, campaign
add/remove, pause, and campaign close must update **both** systems in one action,
so they can never drift. It also lets Campaign Managers run ClipGrow operations
(create a clipper, add someone to a campaign) from inside Discord with a slash
command instead of logging into the admin portal.

**In scope for the bot:**

- Staff slash commands: `/clipper`, `/verify`, `/promote`, `/campaign-add`,
  `/pause`, `/campaign-close`, etc. (§9).
- Tier-aware buttons on the campaign board (Editor applies → ticket; Clipper joins
  → instant).
- Creating a campaign's Discord category/channels/role when a campaign is
  imported from ClipGrow.
- A nightly reconcile that reports Discord ↔ ClipGrow drift.

**Explicitly NOT the bot's job** (use Carl-bot + Ticket Tool — §7):

- Welcome messages, join autoroles, logging, automod, reaction-role menus.
- The ticket UIs themselves (application, rookie iteration, level-up, campaign
  application). Ticket Tool owns the ticket; the bot is invoked at the end via a
  slash command or button.
- Membership screening, the "have you edited before?" onboarding prompt.

**Hard constraints:**

- **The bot must not share a process or a deploy with the ClipGrow website.** A
  bot bug cannot be allowed to take down `clipgrow.in`.
- The bot talks to ClipGrow **only** through the dedicated `/api/bot/*` HTTP API
  in §10, authenticated with a shared secret. It never touches ClipGrow's
  database directly and never imports ClipGrow's code.
- ClipGrow stays the system of record. The bot holds as little state as possible.

---

## 2. ClipGrow — the system you're integrating with

### 2.1 What ClipGrow does

ClipGrow runs clipping campaigns for brands. A **clipper** connects their own
Instagram / YouTube account, posts short clips cut from a campaign's source
material, and earns **per 1,000 views** (CPM). ClipGrow tracks the view counts by
polling the Instagram Graph API / YouTube Data API, computes earnings, and records
payouts. It has three user types: **clippers** (a dashboard at `/dashboard`),
**clients / brands** (a dashboard at `/client-dashboard`), and a single
**admin** (portal at `/admin`).

### 2.2 Stack & architecture

| Piece | Detail |
|---|---|
| Runtime | **Cloudflare Workers** (single Worker), entry `src/worker.js` |
| Language | plain JS, ES modules, `nodejs_compat` compat flag |
| Config | `wrangler.jsonc` — worker name `clipgrow`, compat date `2026-07-02` |
| Database | **Cloudflare D1** (SQLite), binding `DB`, name `clipgrow` |
| Static assets | served from the repo root, binding `ASSETS`, `run_worker_first: true` (the Worker inspects every request before a static file is served, so it can gate `/dashboard`, `/tracker`, `/client-dashboard` behind a login) |
| Background work | **Cloudflare Queues** (`clipgrow-refresh`, binding `REFRESH_QUEUE`) for chained view-count refresh jobs; **Cron** `0 */6 * * *` for the global refresh |
| Hosting | `clipgrow.in` (Cloudflare) |

### 2.3 How requests are routed (so you can add `/api/bot/*` cleanly)

`src/worker.js` holds an ordered array:

```js
const handlers = [handleInstagramAuth, handleYoutubeAuth, handleAdmin,
                  handleClipper, handleClient, handlePublic, handleMedia];
```

For any `/api/*` request the Worker tries each handler in turn; each is
`async (request, env, url) => Response | null`. The first non-null response wins;
if all return null → 404. **Adding the bot API = write `src/routes/bot.js`
exporting `handleBot`, and add it to that array** (near the front, before
`handlePublic`).

Shared helpers you'll reuse:

| Module | Exports you need |
|---|---|
| `src/http.js` | `json(data, status?)`, `err(msg, status?)`, `readJson(request)`, `matchPath('/api/bot/clippers/:id', pathname)` |
| `src/auth.js` | `hashPassword(pw) → {hash, salt}` (PBKDF2-SHA256, 100k iterations, per-user salt) |
| `src/db.js` | `now()`, `normalizeUsername()`, `slugify()`, `getCampaignById()`, `publicClipper()`, `clipperFinancials()` |
| `src/access.js` | `submitAccessRequest(db, {clipperId, campaignId, platform, identifier})` |
| `src/earnings.js` | `reallocateCampaign(db, campaignId)` — recomputes per-clip earnings after a participation change |

### 2.4 Data model — the tables the bot's operations touch

```
clippers        id, username (unique), password_hash, password_salt,
                display_name, status ('active' | 'disabled'), created_at
                + NEW: tier ('editor' | 'clipper')   ← added by migration 020

campaigns       id, name, description, cpm, budget,
                status ('active' | 'budget_full' | 'completed'), created_at,
                slug, min_views, platforms (comma list e.g. "instagram,youtube")
                + NEW: discord_role_id, discord_category_id,
                       discord_brief_channel_id, discord_manager_id,
                       discord_board_message_id

participations  id, clipper_id, campaign_id, account_id,
                status ('active' | 'paused' | 'kicked'),
                status_note, status_changed_at, joined_at
                UNIQUE(clipper_id, campaign_id)

submissions     id, clipper_id, campaign_id, permalink, views,
                earning, frozen_earning, locked_at, status, created_at
                — the individual posted clips. "posted clip count" for the
                  ~20–30 level-up flag = COUNT(*) WHERE status='active'.

social_accounts id, clipper_id, platform ('instagram'|'youtube'),
                external_id, username, status, connected_at

tester_requests id, clipper_id, campaign_id, platform, identifier,
                status ('pending' | 'confirmed'), requested_at, confirmed_at
                — the per-campaign "can this account connect yet?" gate.
                  submitAccessRequest() writes here.

payments        id, clipper_id, campaign_id, amount, method, paid_at
                — the payout ledger. The bot NEVER writes here.

+ NEW: discord_links   discord_user_id (PK), clipper_id, discord_username, linked_at
```

### 2.5 Auth model — and the gap the bot API fills

ClipGrow authenticates humans with a `cg_session` cookie (HMAC-SHA256 signed with
`SESSION_SECRET`, payload `{role, sub, exp}`, roles `admin` | `clipper` |
`client`). The admin is a **single account** — `POST /api/admin/login` checks one
password against the `ADMIN_PASSWORD` secret.

**There is no machine-to-machine / API-key auth today.** The `/api/bot/*`
namespace (§10) adds exactly one: a bearer token (`BOT_API_SECRET`) checked at the
top of `handleBot`. It grants the bot a deliberately narrow set of operations —
not full admin.

### 2.6 The one rule that is non-negotiable

From the ClipGrow repo's `CLAUDE.md`:

> Every write that can change a `submissions.earning` value or its lock fields
> (`frozen_earning`, `locked_at`) must carry `WHERE id = ? AND locked_at IS NULL`,
> and the caller must check `meta.changes` before assuming it applied. A locked
> clip is financial history — it must never be silently overwritten.

The bot API touches this **only** through participation status changes
(pause/kick freezes a clipper's unpaid clips at current value). **Do not
hand-write that logic.** §10 says to reuse ClipGrow's existing
`PATCH /api/admin/participations/:id` code path, which already does the freeze
correctly with `reallocateCampaign()`.

### 2.7 Deploying ClipGrow (context — Dhruv's Claude does this)

`npm test` (validates every SQL string against the schema, checks module
integrity and page functions — it catches bad migrations and broken routes), then
`npx wrangler deploy`. The D1 database and the Worker already exist in Dhruv's
Cloudflare account.

---

## 3. Why HTTP-interactions, not a gateway bot

The bot needs: slash commands, buttons, modals, role add/remove, DMs, channel
creation. **All of that works over Discord's HTTP Interactions model** (register
an Interactions Endpoint URL; Discord POSTs each interaction; reply within 3s,
deferring if slower) plus normal REST calls with a bot token.

It does **not** need to watch message traffic or presence. The only events it
can't see under HTTP-interactions are "member joined / left":

- **Joined** — handled by Discord's native Membership Screening + Onboarding.
- **Left** — caught by the nightly reconcile (§13).

So there's no reason to hold a gateway connection. If you'd rather build it
gateway-style with discord.js out of habit, the ClipGrow API contract is
identical — but HTTP-interactions is what makes the serverless hosting option
viable and keeps it cheap.

---

## 4. Hosting — Endrig's call

| Option | What | Pros | Cons |
|---|---|---|---|
| **A — separate Cloudflare Worker** *(design's default)* | its own Worker, own repo, own subdomain (e.g. `bot.clipgrow.in`); HTTP-interactions; own D1 if needed | free; same platform as the site but fully isolated; scales to zero; Cron included for reconcile; Dhruv already has a Cloudflare account | Workers can't hold a gateway connection (not needed here) |
| **B — inside the ClipGrow Worker** | add bot routes to `src/worker.js` | simplest data access | **breaks the hard constraint** (shared blast radius). Do not. |
| **C — small Node service** (Railway / Fly / a VPS) | always-on Node + discord.js | full library ecosystem; can add gateway features later; use whatever you're comfortable hosting | a server to maintain + ~$5/mo; still calls the same `/api/bot/*` API |

**Recommendation: A**, unless you specifically want a Node/discord.js setup or
gateway features, then **C**. The ClipGrow side (§10) is identical either way, so
this decision does not block starting.

---

## 5. Cloudflare & credentials — who provides what

There are **two different "Cloudflare" concerns**; don't conflate them:

### 5.1 The bot talking to the ClipGrow website — NO Cloudflare access needed

The ClipGrow Worker is just a public HTTPS server. The bot is an HTTP client. It
calls `https://clipgrow.in/api/bot/*` with `Authorization: Bearer
<BOT_API_SECRET>`. That's the entire integration. It works from Cloudflare, from a
VPS, from your laptop — anywhere that can make an HTTPS request. **No Cloudflare
API token is involved in bot ↔ ClipGrow traffic.**

*(Optimisation for later: if the bot ends up on Cloudflare too (option A), a
**Service Binding** lets it call the ClipGrow Worker Worker-to-Worker without
going over the public internet or needing the bearer secret. It couples the two
deploys slightly. Start with plain HTTPS + bearer; switch later if wanted.)*

### 5.2 Deploying the bot ITSELF to Cloudflare — only if you pick option A

If the bot runs as a Cloudflare Worker, deploying it needs Cloudflare auth.
Dhruv provides:

- A **Cloudflare API token** (dash → My Profile → API Tokens → Create Token),
  scoped to the minimum:
  - `Account` → `Workers Scripts` → **Edit**
  - `Account` → `Workers KV Storage` → **Edit** *(only if the bot uses KV)*
  - `Account` → `D1` → **Edit** *(only if the bot has its own D1)*
  - `Zone` → `Workers Routes` → **Edit** for the `clipgrow.in` zone *(only if you
    want `bot.clipgrow.in`; skip if you use the default `*.workers.dev` URL)*
- The **Cloudflare Account ID** (dash → Workers & Pages → right sidebar).

These go into **GitHub Actions secrets** (`CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`) so deploys run from CI, not from anyone's laptop — see
§15. If you pick option C, you don't need any of this; you deploy to your host
however that host works.

### 5.3 Discord credentials — Dhruv sets up, shares with Endrig

Dhruv creates the Discord application (discord.com/developers):

- **Application ID** (`DISCORD_APP_ID`)
- **Public Key** (`DISCORD_PUBLIC_KEY`) — for verifying interaction signatures
- **Bot token** (`DISCORD_BOT_TOKEN`) — Bot tab → Reset Token
- Invite the bot to the server with scopes `bot` + `applications.commands` and
  permissions: Manage Roles, Manage Channels, Send Messages, Create Public
  Threads, Send Messages in Threads, Embed Links, Read Message History.
- The bot's role must sit **above** every `@Campaign: *` role in Server Settings →
  Roles (a bot can only assign roles below its own).
- Once Endrig has a deploy URL, set it as the **Interactions Endpoint URL** in the
  app's General Information tab (Discord sends a test PING; the bot must verify
  the signature and reply `{ "type": 1 }` or the URL is rejected).

### 5.4 ClipGrow credentials — Dhruv sets up

- `BOT_API_SECRET` — generate a long random string
  (`openssl rand -hex 32`), set on the ClipGrow Worker with
  `npx wrangler secret put BOT_API_SECRET`, and hand the value to Endrig for the
  bot's config.
- Nothing else — the bot never gets ClipGrow's admin password, session secret, or
  database.

### 5.5 Discord server structure — Dhruv sets up, gives Endrig the IDs

Roles and channels per the Agency Operating System PDF §15 and §8.5 below. Dhruv
gives Endrig Admin on the server plus every role ID and channel ID the bot needs
(§11 config block).

### 5.6 Summary table

| Item | Who creates it | Who holds it | Where it's stored |
|---|---|---|---|
| `BOT_API_SECRET` | Dhruv | both | ClipGrow Worker secret + bot config |
| `/api/bot/*` API + migration 020 | Dhruv's Claude (clipgrow repo) | — | clipgrow repo |
| Discord app + bot token + public key | Dhruv | both | Discord dev portal + bot config |
| Discord roles/channels + IDs | Dhruv | both | server + bot config |
| Cloudflare API token + account ID | Dhruv | Endrig / CI | GitHub Actions secrets (option A only) |
| Bot code + hosting | Endrig | Endrig | new `clipgrow-discord-bot` repo |

---

## 6. How the bot talks to ClipGrow — worked examples

All calls: `https://clipgrow.in/api/bot/...`, header
`Authorization: Bearer <BOT_API_SECRET>`, JSON in/out.

### 6.1 A Campaign Manager runs `/clipper create @user`

```
Discord ──/clipper create @user display:"Rahul"──▶ bot
bot ──POST /api/bot/clippers  {display_name:"Rahul"}──▶ ClipGrow
      ClipGrow: normalizeUsername → "rahul" (+ suffix if taken),
                hashPassword(random), INSERT INTO clippers (... tier='editor'),
      ◀── {id: 87, username: "rahul", temp_password: "…"} ──
bot ──PUT role @Editor on the member──▶ Discord
bot ──POST /api/bot/clippers/87/link  {discord_user_id, discord_username}──▶ ClipGrow
bot ──DM the user: username + temp_password + https://clipgrow.in/clipper──▶ Discord
bot ──message in #creds-audit: "@user → clipper #87 (rahul) by @manager"──▶ Discord
bot ──edit the deferred interaction reply: "✅ done"──▶ Discord
```

### 6.2 An Editor is approved onto a campaign (`/campaign-add`)

```
bot ──POST /api/bot/campaigns/12/participants
        {clipper_id: 87, identifier: "rahul.clips"}──▶ ClipGrow
      ClipGrow: guard against existing/kicked participation,
                INSERT INTO participations (... status='active'),
                submitAccessRequest(db,{clipperId:87, campaignId:12,
                                        platform:'instagram',
                                        identifier:'rahul.clips'})
      ◀── {participation_id: 305} ──
bot ──PUT role @Campaign: NikeRun on the member──▶ Discord
bot ──message in #nikerun-chat: "welcome @user"──▶ Discord
```

### 6.3 Nightly reconcile

```
bot ──GET /api/bot/reconcile──▶ ClipGrow
      ◀── { clippers:[…], participations:[…] } ──
bot: for each linked clipper, GET their Discord member roles,
     diff against ClipGrow state,
     post any mismatch to #bot-log. Never auto-fix.
```

---

## 7. Division of labour

| Capability | Owner |
|---|---|
| Membership screening, rules gate | Discord native |
| "Have you edited before?" onboarding prompt | Discord Onboarding |
| Welcome DM, join/leave/role-change logging, automod | Carl-bot |
| Application form, rookie iteration ticket, campaign application ticket, level-up ticket | Ticket Tool v2 |
| "Notify me about new campaigns" opt-in role (optional) | Carl-bot reaction role |
| **Everything that changes ClipGrow state** | **the custom bot** |
| Campaign board posts + Apply/Join buttons | the custom bot |
| Campaign category/channel/role creation on import | the custom bot |
| Nightly reconcile | the custom bot |

**Handoff pattern (v1):** Ticket Tool runs the ticket UI; when a Coach or Manager
is done, they run a bot slash command (`/verify @user`, `/campaign-add @user
campaign:x`) inside the ticket channel and the bot does the ClipGrow side + role
assignment. A later version can put Approve/Reject buttons directly in
`#campaign-review` / `#coach-queue`.

---

## 8. Discord structures the bot assumes exist

### 8.1 Roles (Dhruv creates; bot needs the IDs)

`@Rookie`, `@Editor`, `@Clipper`, `@Campaign Manager`, `@Coach`, `@Head`,
`@Client Lead`, `@Tech`, `@Staff`, `@Paused`, `@Removed`, and the bot's own role
(**above** every `@Campaign: *` role).

`@Campaign: <name>` roles are **created by the bot** on campaign import.

### 8.2 Channels (bot needs the IDs)

Full map in the Agency Operating System PDF §15. The bot specifically needs:
`#open-campaigns`, `#campaign-review`, `#coach-queue`, `#level-ups`, `#bot-log`,
`#creds-audit`, `#announcements`.

### 8.3 Permission model

View access is set per role at the **category** level. `@Campaign: <name>`
unlocks its own campaign category. `@Clipper` additionally gets read-only access
to each `#<name>-brief` (an overwrite the bot adds on creation, so Clippers can
browse briefs to choose campaigns). `@Paused` = deny Send in campaign +
community-post channels. `@Removed` = deny View everywhere except `#rules` + an
appeals channel.

---

## 9. Bot commands & interactions

All slash commands are **Staff-only** — gate with Discord's
`default_member_permissions` **and** re-check `interaction.member.roles`
server-side.

### 9.1 `/clipper` — manage ClipGrow accounts from Discord

| Subcommand | Actor | Behaviour |
|---|---|---|
| `/clipper create @user [display] [tier]` | Manager / Head | `POST /api/bot/clippers` → DM creds → assign `@Editor` (or `@Clipper` if `tier:clipper`) → `POST …/link` → log to `#creds-audit`. For fast-lane hires, WhatsApp migration, or a manager vouching for someone directly. |
| `/clipper link @user username:<x>` | Manager / Head | link an **existing** ClipGrow account to this Discord user: `GET /api/bot/clippers?username=x` → `POST …/link` → set the Discord role from the account's `tier`. Use this to onboard clippers who already have logins. |
| `/clipper info @user` | Staff | show the linked ClipGrow account, tier, active campaigns, any pauses. |
| `/clipper disable @user [reason]` | Head | `PATCH /api/bot/clippers/{id} {status:"disabled"}` → strip ranks + campaign roles → `@Removed` → DM. |

### 9.2 Rank & campaign commands

| Command | Actor | Behaviour |
|---|---|---|
| `/verify @user` | Coach / Head | Rookie → Editor graduation. Same as `/clipper create` internally, plus removes `@Rookie` and closes the iteration ticket. |
| `/promote @user` | Head only | `PATCH /api/bot/clippers/{id} {tier:"clipper"}` → swap `@Editor`→`@Clipper` → DM. |
| `/demote @user [reason]` | Head only | reverse of promote. |
| `/campaign-create` | Head | `GET /api/bot/campaigns?state=importable` → select menu → create category + `#<n>-brief`/`#<n>-submissions`/`#<n>-chat` + `@Campaign: <n>` role + `@Clipper` read overwrite on brief + board post in `#open-campaigns` → `PATCH /api/bot/campaigns/{id}` with the created Discord IDs. |
| `/campaign-manager @user campaign:<n>` | Head | add `@Campaign Manager` → `PATCH /api/bot/campaigns/{id} {discord_manager_id}`. |
| `/campaign-add @user campaign:<n> handle:<h>` | Manager / Head | `POST /api/bot/campaigns/{id}/participants {clipper_id, identifier:h}` → add `@Campaign: <n>` → welcome in `#<n>-chat`. (Editor path — after the verification video passes.) |
| `/campaign-remove @user campaign:<n> [reason]` | Manager / Head | `PATCH /api/bot/participations/{id} {status:"kicked", note}` → remove `@Campaign: <n>` → DM. |
| `/pause @user campaign:<n> [reason]` | Manager / Head | `{status:"paused"}` → add `@Paused` → DM. |
| `/resume @user campaign:<n>` | Manager / Head | `{status:"active"}` → remove `@Paused`. |
| `/campaign-close campaign:<n>` | Head | `PATCH /api/bot/campaigns/{id} {status:"completed"}` → remove `@Campaign: <n>` from all members → rename category `📁 <n>-archived` + deny Send → wrap-up in `#announcements` → delete the board message. |
| `/status` | any Editor/Clipper | `GET /api/bot/clippers/by-discord/{id}` → DM their tier, campaigns, pauses, dashboard link. |

### 9.3 Buttons / modals

**Campaign board — one "Apply / Join" button per campaign post.** Branch on the
clicker's top role:

- `@Clipper` → modal for the posting handle → immediately
  `POST /api/bot/campaigns/{id}/participants` → add `@Campaign: <n>` → post in
  `#<n>-chat`: "welcome — drop your verification clip here before you go live."
- `@Editor` → if they already hold a `@Campaign: *` role → ephemeral "finish your
  current campaign first". Else open a Ticket Tool campaign-application ticket
  pre-loaded with the brief link + a prompt for handle + verification video.
- `@Rookie` / no rank → ephemeral: "campaign work starts at Editor — see
  `#how-it-works`".

**`#campaign-review` (v2):** Approve / Reject buttons under each submitted
verification video that call the `/campaign-add` logic directly.

### 9.4 Deferred responses

Any command that calls ClipGrow then Discord REST will exceed the 3s limit — ACK
with a deferred (ephemeral) "working…" then edit the reply.

---

## 10. ClipGrow API the bot calls — `/api/bot/*` (to be built)

New handler `src/routes/bot.js` in the **clipgrow** repo, added to the `handlers`
array in `src/worker.js` (before `handlePublic`). Reuses existing internal logic.
It is the **only** ClipGrow surface the bot touches.

**Auth:** every request carries `Authorization: Bearer <BOT_API_SECRET>`; the
handler rejects anything else with 401. No cookies, no admin session.

**Base:** `https://clipgrow.in/api/bot`

| Method + path | Body | Returns | Implementation notes |
|---|---|---|---|
| `POST /clippers` | `{display_name}` | `{id, username, temp_password}` | bot generates + delivers the password. Reuse `POST /api/admin/clippers` logic: `normalizeUsername(display_name)` + uniqueness suffix, `hashPassword(random)`, `INSERT INTO clippers (... status='active')`, set `tier='editor'`. Extract to `createClipper()` in `src/db.js` and call from both. |
| `GET /clippers?username=<x>` | — | `{clipper}` or 404 | for `/clipper link` |
| `GET /clippers/by-discord/{discordId}` | — | `{clipper, tier, participations:[…]}` or 404 | `discord_links` join |
| `POST /clippers/{id}/link` | `{discord_user_id, discord_username}` | `{ok}` | `INSERT OR REPLACE INTO discord_links` |
| `GET /clippers/{id}/stats` | — | `{tier, posted_clip_count, participations:[{campaign_id, name, status}]}` | `posted_clip_count = COUNT(*) FROM submissions WHERE clipper_id=? AND status='active'` — drives the ~20–30 level-up flag |
| `PATCH /clippers/{id}` | `{tier?, status?}` | `{ok}` | `tier` → simple update; `status` → reuse `PATCH /api/admin/clippers/:id` (`active`/`disabled` only) |
| `GET /campaigns?state=importable\|active\|all` | — | `[{id, name, cpm, budget, status, min_views, platforms, slug, discord_role_id, discord_category_id}]` | `importable` = `status='active' AND discord_category_id IS NULL` |
| `PATCH /campaigns/{id}` | `{status?, discord_role_id?, discord_category_id?, discord_brief_channel_id?, discord_manager_id?, discord_board_message_id?}` | `{ok}` | `status` → reuse `PATCH /api/admin/campaigns/:id` (`active`/`budget_full`/`completed`, incl. its account-freeing on `completed`). Discord id columns are new, nullable. |
| `POST /campaigns/{id}/participants` | `{clipper_id, identifier, platform?}` | `{participation_id}` | guard against existing/`kicked` (see the join handler in `src/routes/clipper.js`), `INSERT INTO participations (clipper_id, campaign_id, status, joined_at) VALUES (?,?, 'active', now())`, then `submitAccessRequest(db, {clipperId, campaignId, platform, identifier})`. Default `platform` from `campaigns.platforms` (first entry) or take it in the body. |
| `PATCH /participations/{id}` | `{status, note}` | `{ok}` | **MUST reuse the exact body of `PATCH /api/admin/participations/:id`** — the `frozen_earning` freeze/unfreeze on kick/reinstate and `reallocateCampaign()`. Extract to `setParticipationStatus()` so bot + admin panel share one copy. This is where §2.6 applies. |
| `GET /reconcile` | — | `{clippers:[{id, tier, status, discord_user_id}], participations:[{clipper_id, campaign_id, status, discord_role_id}]}` | plain selects; the bot diffs and reports |

### 10.1 Schema migration — `migrations/020_discord.sql` (clipgrow repo)

```sql
CREATE TABLE discord_links (
  discord_user_id  TEXT PRIMARY KEY,
  clipper_id       INTEGER NOT NULL REFERENCES clippers(id),
  discord_username TEXT,
  linked_at        INTEGER NOT NULL
);
ALTER TABLE clippers  ADD COLUMN tier TEXT NOT NULL DEFAULT 'editor';
ALTER TABLE campaigns ADD COLUMN discord_role_id           TEXT;
ALTER TABLE campaigns ADD COLUMN discord_category_id       TEXT;
ALTER TABLE campaigns ADD COLUMN discord_brief_channel_id  TEXT;
ALTER TABLE campaigns ADD COLUMN discord_manager_id        TEXT;
ALTER TABLE campaigns ADD COLUMN discord_board_message_id  TEXT;
```

Rookies have **no** `clippers` row — they don't exist in ClipGrow until `/verify`
or `/clipper create`. `tier` only ever holds `'editor'` or `'clipper'`.

### 10.2 Building the ClipGrow side

Do this in the **clipgrow** repo, ideally in Dhruv's Claude session (its
`CLAUDE.md` carries the financial-safety rule). Steps: write `020_discord.sql`,
write `src/routes/bot.js`, extract `createClipper()` and
`setParticipationStatus()` as shared helpers, `npm test`, `npx wrangler deploy`,
`npx wrangler secret put BOT_API_SECRET`.

---

## 11. Bot-side data & config

State: minimal. `discord_links` and all campaign↔role mapping live in ClipGrow and
are fetched as needed (cache with a short TTL if you like). The only thing purely
bot-side is the board-message ↔ campaign mapping, and that's also mirrored to
ClipGrow as `discord_board_message_id`.

Config (env / secrets):

```
DISCORD_APP_ID
DISCORD_PUBLIC_KEY
DISCORD_BOT_TOKEN
DISCORD_GUILD_ID
CLIPGROW_API_BASE            = https://clipgrow.in/api/bot
BOT_API_SECRET
ROLE_ROOKIE ROLE_EDITOR ROLE_CLIPPER ROLE_STAFF ROLE_HEAD
ROLE_COACH ROLE_CAMPAIGN_MANAGER ROLE_PAUSED ROLE_REMOVED
CHAN_OPEN_CAMPAIGNS CHAN_CAMPAIGN_REVIEW CHAN_COACH_QUEUE
CHAN_LEVEL_UPS CHAN_BOT_LOG CHAN_CREDS_AUDIT CHAN_ANNOUNCEMENTS
```

On Cloudflare Workers these are `wrangler secret put` (secrets) + `vars` in
`wrangler.jsonc` (the non-secret IDs). On a Node host, a `.env` file (git-ignored)
+ your host's secret manager.

---

## 12. Security

- **Verify every interaction's Ed25519 signature** (`X-Signature-Ed25519` /
  `X-Signature-Timestamp` against `DISCORD_PUBLIC_KEY`) before doing anything.
  Discord sends unsigned probes; reject them with 401.
- Gate every staff command twice: Discord command permissions **and** a
  server-side `interaction.member.roles` check.
- `BOT_API_SECRET` is the only thing between the bot and clipper-account creation
  — treat it like a password. Rotate on any suspicion (change on the Worker +
  bot).
- Never log credentials. `temp_password` goes into exactly one DM, nowhere else.
- On a failed credential DM (user has DMs closed), post a non-sensitive "couldn't
  DM @user — reach them manually" note to `#creds-audit` — never the password.

---

## 13. Nightly reconcile

A cron job (Worker Cron on option A; `node-cron` on option C), once a day:

1. `GET /api/bot/reconcile`.
2. For each linked clipper, fetch their Discord member roles.
3. Report to `#bot-log` any of:
   - `@Clipper` in Discord but `tier='editor'` in ClipGrow (or vice versa)
   - holds `@Campaign: X` but no `active` participation in X
   - has an `active` participation in X but no `@Campaign: X` role
   - `@Editor`/`@Clipper` with no `discord_links` row
   - a linked clipper who has left the server
4. It **only reports.** A human fixes. Never auto-mutate on reconcile.

---

## 14. Build order

1. **ClipGrow side first** (clipgrow repo): `migrations/020_discord.sql`,
   `src/routes/bot.js` with the §10 endpoints, extract `createClipper()` and
   `setParticipationStatus()`, `npm test`, deploy, `wrangler secret put
   BOT_API_SECRET`. Now there's a stable API to build against.
2. **Bot skeleton** (new repo): interactions endpoint, signature verification,
   command registration against a **test guild**, `/status` and `/clipper info`
   (read-only) to prove the ClipGrow round-trip.
3. **Write commands**: `/clipper create`, `/clipper link`, `/verify`,
   `/campaign-add`, `/pause`, `/resume`, `/campaign-remove`, `/clipper disable`.
   Test each against a throwaway clipper — confirm the ClipGrow row **and** the
   Discord role both change.
4. **Campaign lifecycle**: `/campaign-create`, `/campaign-manager`,
   `/campaign-close`, the board button.
5. **Reconcile.**
6. Point the real guild's Interactions Endpoint URL at the deployed bot; register
   commands for the guild.

---

## 15. Working together — shared repo & memory

Claude Code has **no shared live memory** between people or machines. What it
shares reliably is a **Git repo**. Set it up so both your Claude sessions and
Endrig's are always working from the same picture.

### 15.1 The bot gets its own GitHub repo

```
gh repo create clipgrow-discord-bot --private
```

Both Dhruv and Endrig get push access. This repo is the shared brain.

### 15.2 Files that ARE the shared memory — commit these

| File | What goes in it |
|---|---|
| `CLAUDE.md` | auto-loaded every session. Put: the stack (from §4 choice), "**never modify or import the clipgrow site repo — integrate only via `https://clipgrow.in/api/bot/*`**", how to run/test/deploy the bot, the command list, and a one-line pointer to `docs/`. |
| `docs/discord-bot-build-spec.md` | **this file** — copy it into the bot repo so Endrig's Claude has the ClipGrow briefing (§2) and the API contract (§10) without needing the clipgrow repo. |
| `docs/clipgrow-api.md` | once §10 is built, the **real** request/response shapes (copy the actual JSON from the working endpoints). This becomes the source of truth over the spec's guesses. |
| `docs/worklog.md` | a running log. **Ask Claude to append an entry at the end of every session**: date, who, what changed, what's next, any gotcha. This is how your session picks up where Endrig's left off and vice-versa. |
| `.claude/notes/*.md` | anything longer-lived — decisions, Discord API quirks hit, rate-limit notes. |

### 15.3 Session workflow

1. **Start of session:** Claude reads `CLAUDE.md` automatically; you then say
   "read `docs/worklog.md` and the last few commits" so it knows the current
   state.
2. **Work on a branch, open a PR.** Never commit straight to `main`. The other
   person (and their Claude) reviews the PR — that's how you both "see how it's
   being built".
3. **End of session:** "append a worklog entry and commit it." Push the branch.
4. **`main` is always deployable.** Merging a PR is what ships (via CI, §15.4).

### 15.4 CI so deploys aren't tied to a laptop

`.github/workflows/deploy.yml`: on push to `main`, run the bot's tests, then
deploy.

- Option A (Cloudflare): `npx wrangler deploy` with
  `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets
  (§5.2).
- Option C (Node host): whatever your host's deploy action is (Railway/Fly both
  have official GitHub Actions).

Now either person — or a Claude cloud session — ships by merging a PR.

### 15.5 Running Claude in the cloud

At **claude.ai/code** you can run Claude Code sessions in a browser sandbox
against a connected GitHub repo. Both of you can start sessions against
`clipgrow-discord-bot`; each works on a branch and opens a PR. It's still
one-session-per-person, but the repo + PRs + `worklog.md` give you the shared
visibility. On a Team plan you can also see each other's cloud sessions.

### 15.6 Keeping the two repos in sync

When §10's API changes in the **clipgrow** repo, Dhruv's session updates
`docs/clipgrow-api.md` in the **bot** repo (and the worklog) in the same sitting.
The bot repo never needs the clipgrow code — only the current API shapes.

---

## 16. Open questions for Endrig / the team

- Hosting option A vs C (§4).
- Campaign application: Ticket Tool + slash-command handoff (less code, v1) or
  fully bot-owned private threads (cleaner UX, more code)?
- One `@Campaign Manager` role for all managers (simpler; fine while managers are
  all Heads) or per-campaign `@Campaign Manager: <name>` roles?
- Command registration: per-guild (instant, single server — recommended) vs
  global (up to 1h propagation)?
- Service Binding instead of the bearer API later, if the bot lands on Cloudflare
  (§5.1)?
