# Website ↔ Discord bot: implementation plan

Written 25 Sep 2026, before any code. Source: Endrig's four documents (`README.md`,
`bot-notify-contract.md`, `bot-link-contract.md`, `bot-campaign-forum-contract.md`), the
current website code, and the current `Endrig7/clipcore` repository.

Rule for this whole plan: **one small phase per deploy, each tagged, each reversible.**
Every phase ships switched off, is proven, then switched on.

---

## 1. Why we are doing this (the motive, so we can judge every option against it)

| Who | Pain today | What "fixed" looks like |
|---|---|---|
| Clippers | Find out a clip was rejected, or that they were paid, only by opening the dashboard and hoping | A Discord DM within seconds of the decision |
| Clippers | "Connect to Discord" is switched off | One click links the account and puts them in the server |
| Staff | Every campaign is a hand-typed forum post (like the Be10x one), out of date the day after | One thread per campaign that keeps itself up to date |
| The business | Discord is where clippers already are; the website is where the truth is; the two do not talk | Discord shows what the website knows, the website never depends on Discord |

Three hard rules carried over from earlier work. Any option that breaks one is rejected.

1. **The bot being down must never affect the website.** Nothing a clipper, moderator or admin
   does may wait on, or fail because of, the bot.
2. **Discord only ever shows what that audience may see.** A public forum post shows only what any
   Discord member may see. A DM shows only that person's own information.
3. **Nothing is switched on until it has been proven, and every step can be undone.**

---

## 2. What Endrig's documents ask for

| Contract | Direction | Endpoint on the bot | Website work |
|---|---|---|---|
| **notify** | website → bot | `POST /notify` (types: `submission_approved`, `submission_rejected`, `payout_sent`, `custom`) | Call it when a clip is reviewed and when a payout is sent |
| **link** | website → bot | `POST /link` `{discord_user_id, access_token}` | Call it after Discord OAuth so the bot adds them to the server |
| **campaign forum** | both | `POST /campaign-sync` (doorbell) and `GET /api/bot/campaigns` (extended) | Add ~18 fields to the campaigns endpoint; ring the doorbell after any campaign change; add `logo_url` |

All three share one listener, one port and one bearer token on the bot's side
(`NOTIFY_WEBHOOK_PORT`, `NOTIFY_WEBHOOK_TOKEN`). Both are still to be supplied by Endrig.

---

## 3. What is actually true today (checked, not assumed)

### Answers to the seven questions in Endrig's README

| # | Question | Answer, from our code |
|---|---|---|
| 1 | Where are campaigns created and edited? | `src/routes/admin.js`: `POST /api/admin/campaigns` (create), `PATCH /api/admin/campaigns/:id` (edit, status), `DELETE`. Table `campaigns`. Joins are in `src/routes/clipper.js` (`INSERT INTO participations`). |
| 2 | Database and how to add columns | Cloudflare D1 (SQLite), raw SQL, numbered files in `migrations/` (next is **052**). Applied to production *before* deploying. |
| 3 | Field storing the clipper's Discord id | `clippers.discord_user_id` (verified through OAuth, unique). `discord_handle` is the verified name. `discord_username` is the old free-text field, **not** an id. |
| 4 | HTTP client | Plain `fetch` (Cloudflare Worker). |
| 5 | Env and secrets convention | Non-secret switches are `vars` in `wrangler.jsonc` (a reviewable, revertable deploy). Secrets are `wrangler secret put`. |
| 6 | Existing OAuth flow | Yes. `src/routes/discord-auth.js` and `src/discord.js` already do the whole Discord Connect flow, including adding the person to the server. Built, tested, deployed, and switched **off** (`DISCORD_LINK: "off"`). |
| 7 | Who changes budget and clipper counts | Budget spent changes whenever clips are re-priced: `reallocateCampaign` / `reallocateAll` in `src/earnings.js`, run after every refresh step, every payout and every kick. That function also flips a campaign between `active` and `budget_full` by itself. Clipper count changes on join (`clipper.js`) and kick. |

### Five things the documents could not know

1. **The listener does not exist in the bot repository.** `Endrig7/clipcore` `main` (latest commit 24 Sep) contains no
   `/notify`, `/link` or `/campaign-sync` code and no `NOTIFY_WEBHOOK_*` setting. It has not been pushed. Until it is, we build
   and prove everything against a **fake bot that behaves exactly as the documents say**.
2. **Whether the bot can be reached at all is unproven.** Endrig's earlier referral request says the bot "runs on a personal
   machine, not a public server, so your backend can't reach into it". These three contracts need exactly that. Cloudflare Workers
   *can* call any port on a normal host (`allow_custom_ports`, default since 2024-09-02), so a public IP and port works.
   A home PC behind a router does not. We must ask where it runs now.
3. **The bot listener is plain HTTP.** The token and every DM (including payout amounts) would cross the internet unencrypted
   between Cloudflare and the bot host. We should ask for HTTPS (a tunnel or a proxied hostname) and treat plain HTTP as a
   warning shown on the admin page.
4. **The forum post would expose things the website deliberately hides.** Raw footage and reference links are shown only to
   clippers who joined a campaign (`clipper.js`: only when `part.status !== 'kicked'`). `source_footage_link` and
   `inspiration_links` in a public forum would leak them. Budget figures are already shown to logged-in users and were
   deliberately removed from the anonymous public API ("the agency's deal sizes"). The hand-written Be10x post did publish the
   budget, so this is a founder decision, not an assumption.
5. **The bot's forum sync creates a thread for every campaign id it is given.** So `/api/bot/campaigns` must list only campaigns
   meant for the forum, and must include finished ones (so they can be marked OVER). Today it lists active campaigns only. The bot's
   existing "campaign list" feature reads the same endpoint, so it must learn to show only `live` campaigns first, or finished
   campaigns would appear as open.

---

## 4. Options considered, and the choice

| | Approach | Bot down | Effort | Verdict |
|---|---|---|---|---|
| **A** | Do exactly what the documents say: call the bot's `/notify`, `/link`, `/campaign-sync` straight from each request | A dead bot slows or breaks the website | Low | **Rejected**. Breaks rule 1. |
| **B** | Skip the bot listener; the Worker talks to Discord directly (DMs, thread creation and editing) | Unaffected | High. We would rewrite the forum logic, and two writers would fight over the same threads | Rejected for the forum and for embeds. |
| **C** | Follow the documents' contracts, but never inside a request: emit an event onto a **Cloudflare Queue**; a consumer delivers it to the bot with a timeout, retries and backoff. Where we already can do it without the bot (adding a member to the server), keep doing that. | Events wait and retry; the website is untouched | Medium | **Chosen.** |

Decisions inside C:

- **Notify and doorbell go through a queue**, with retries and a full record in a new `bot_events` table (so support can answer "did Ravi get told?").
- **The doorbell is coalesced.** The bot re-reads the whole list on every ring, so we ring only when something the post shows actually changed, and at most about once every 20 seconds. Budget is compared in 1% steps so a single clip does not trigger an edit. This is purely an optimisation: skipping a pointless ring changes nothing on the bot.
- **Connect-to-Discord stays Worker-direct.** The Worker already holds the bot token and already adds the member with the same Discord call the bot would make. Sending the user's OAuth access token over plain HTTP to another machine adds risk and a dependency for no gain. The welcome DM the bot sends on a join is reproduced through the notify pipeline (phase 9, optional). If Endrig strongly prefers `/link`, it can be added later as "try the bot first, fall back to direct".
- **A short DM fallback** (phase 9): if the bot has been unreachable for ~10 minutes, send the DM directly through Discord's API using the bot token we already hold, so clippers are still told.

---

## 5. Decisions needed (with my recommendation)

| # | Decision | Recommendation | Who | Blocks |
|---|---|---|---|---|
| D1 | Where does the bot run, is that address public, and can it be HTTPS? | Public host and port; HTTPS through a tunnel if possible | Endrig | Going live for phases 3 to 8 (not building them) |
| D2 | When is the listener code pushed, and what are the URL and token? | Endrig pushes it; token created by Endrig and sent privately | Endrig | Going live |
| D3 | Forum privacy: which fields are public? | Show the brief, CPM, cap, status, clipper count. **Budget: your call** (the manual post showed it). **Never** post footage or reference links unless a per-campaign switch says so | Dhruv | Phase 6 defaults |
| D4 | What does a budget-full campaign show? | **PAUSED** (not OVER), with a line saying the budget is fully allocated. OVER locks and archives the thread and should mean finished | Dhruv | Phase 7 |
| D5 | Which events send a DM? | Clip tick → "approved", cross → "rejected" with the reviewer's feedback, skip → no DM. Video-approval verdicts → a custom message. Payout → `payout_sent` with the clipper's own amount | Dhruv | Phases 3 to 5 |
| D6 | Connect flow: Worker-direct or via the bot's `/link` | Worker-direct | Dhruv, Endrig | Phase 9 only |
| D7 | Campaign unpublished or deleted: what happens to its thread? | Bot archives the thread of any id that disappears | Endrig | Phase 7 |
| D8 | Who fills emoji, logo, do/don't lists? | An admin "Discord post" section on the campaign editor. Logo is a pasted https URL | Dhruv | Phase 6 |
| D9 | DM fallback when the bot is down | Yes | Dhruv | Phase 9 |

None of these blocks phases 0 to 2.

---

## 6. Design

```
                                    (the website never waits on anything below this line)
 admin/moderator/clipper action ──▶ D1 commit ──▶ emit event ──▶ [Queue] ──▶ consumer ──▶ bot listener ──▶ Discord
                                                   (never throws)    │            │  timeout 6 s
                                                                     │            └─ retry 30s, 2m, 10m, 1h … up to 24 h
 hourly cron ─▶ "did any forum-visible campaign change?" ─▶ same queue (safety net for a missed ring)

 bot ──(hourly poll, and after each ring)──▶ GET /api/bot/campaigns ──▶ forum threads
```

Inert until switched on: no URL or token → nothing is emitted. Two valves in `wrangler.jsonc`: `BOT_NOTIFY` (DMs) and `BOT_FORUM`
(extended list and doorbell), each `off` or `on`, shipped `off`.

**Emergency stop, no deploy needed:** delete the `BOT_NOTIFY_TOKEN` secret and the consumer stops calling out.

---

## 7. Phases

Each phase: goal, what changes, tests written **first**, how we prove it in production, how we undo it. Tags run
`checkpoint/23…`.

### Phase 0. Preparation (nothing touches production)
- Fake bot for tests: `test/helpers/fake-bot.mjs`, a real local HTTP server implementing the three contracts exactly as documented
  (validation messages, `202` / `200` variants, `event_id` dedupe for 30 minutes, `401`, and switchable misbehaviour: `500`,
  hang, dropped connection, slow reply).
- Contract validator: `test/helpers/bot-contract.mjs`, the documented rules in code (required fields, types, 256 / 4096 limits).
  Every payload we produce is checked against it.
- Bot-side, safe today: change `src/utils/campaignList.js` in the bot to show only campaigns whose `status` is `live`
  (missing status counts as live, so nothing changes now). This must land **before** phase 7.
- Send Endrig the questions D1, D2, D7.
- **Exit:** fake bot passes its own self-test; decisions D3 to D5 answered.

### Phase 1. Turn on the Connect-to-Discord flow that already exists
Nothing to build. This is the quickest visible win and needs nothing from the bot listener.
1. Register `https://clipgrow.in/api/auth/discord/callback` as a Redirect in the Discord Developer Portal (Dhruv or Endrig).
2. Give the bot the *Create Instant Invite* permission (needed to add members).
3. Run **Check Discord** in the admin Campaigns tab until every line is green.
4. Set `DISCORD_LINK: "optional"`, deploy, and test with one real account end to end: click Connect, authorise, land on the dashboard,
   appear in the server, handle shown.
- **Tests:** already covered (24 + 8 tests). Add one regression test for the "already a member" and "banned" replies if missing.
- **Undo:** set `DISCORD_LINK` back to `"off"` and deploy.

### Phase 2. The outbound pipe (inert)
- Migration **052**: table `bot_events` (id, event_id, kind, discord_user_id, status, attempts, last_error, payload_json, created_at,
  delivered_at). Pruned after 30 days.
- `wrangler queues create clipgrow-bot-events` (and a `-dlq`), producer and consumer bindings added to `wrangler.jsonc`.
  The existing queue handler branches on `batch.queue` so the refresh queue is untouched.
- `src/bot-client.js`: one `fetch` wrapper with a 6-second timeout. Error kinds: not configured, timeout, network, unauthorized,
  bad payload, server error. It never logs or returns the token, and warns if the URL is not HTTPS.
- `src/bot-events.js`: `emitBotEvent(env, event)` validates, records, enqueues and **never throws**. The consumer classifies the
  reply: 2xx done; 400 is our bug (record, no retry); 401 is a configuration problem (alert, slow retry); 5xx, timeout and network
  errors retry with backoff up to 24 hours, then give up and record.
- Admin: **Check bot connection** (host, HTTPS, token accepted, last success) and **Send test DM** to a Discord id you type.
  The connection check uses `POST /campaign-sync {}` as its probe, since the bot has no ping.
- **Tests first:** client error kinds and timeouts against the fake bot; consumer retry and backoff table; token never appears in
  any log line or response; missing queue binding is a silent no-op; queue send failure does not fail the caller; new admin routes
  covered automatically by the hostile-input sweep; migration checked by the schema tests.
- **Prove in production:** deploy inert; set the two secrets; **Check bot** goes green; **Send test DM** to a teammate; DM arrives.
- **Undo:** delete `BOT_NOTIFY_TOKEN`, or redeploy the previous tag. The migration is additive.

### Phase 3. DM when a clip is reviewed
- Hook: after `submitReview` succeeds (`admin.js`, `moderator.js`), in the route, after the commit.
- Tick → `submission_approved` (campaign, platform, views, clip link). Cross → `submission_rejected` (campaign, the reviewer's
  feedback as `reason`, dashboard link). Skip → nothing. Event id `submission_<id>_<verdict>`.
- Only for a clipper with a verified `discord_user_id` whose account is active. Otherwise recorded as `skipped` with the reason.
- **Tests first:** exactly one event per verdict; none on the 409 "already reviewed" or 404; none for unlinked or archived
  clippers; payload passes the contract validator; reviewer *name* never appears; text longer than the limits is cut, not rejected;
  a failing queue or dead bot does not change the review result or its status code; the review write is untouched.
- **Prove:** review one real clip from a teammate's linked account. **Undo:** flip `BOT_NOTIFY` to `off`.

### Phase 4. DM when a verification video is decided
- Hook: after `reviewApplication` succeeds (`moderator.js`). Approved → `custom` ("Video approved ✅, you can now connect your
  account"). Rejected → `custom` with the moderator's note, how many tries are left, and, on the third rejection, that they were removed
  from the campaign. Event id `application_<id>_<verdict>`.
- **Tests first:** same pattern as phase 3, plus the three-strikes wording and that a rejected clipper gets no "resubmit" link they
  cannot use.

### Phase 5. DM when a payout is sent
- Hook: after `settlePayment` succeeds (`admin.js`) and after an advance or bonus payment. Only after the payment is committed, so a
  failure can never touch money. `payout_sent` with the clipper's own amount, method and reference. Event id `payment_<id>`.
- **Tests first:** one event per payment; none when the settle is refused; the amount equals the recorded payment to the paisa;
  never includes another clipper's data; the "locked at" money rule and payout tests still pass unchanged.
- The DM contains the clipper's own money in their own private message. That is deliberate (D5).

### Phase 6. Campaign post data (no visible change)
- Migration **053**: `campaigns.discord_publish INTEGER NOT NULL DEFAULT 0` and `campaigns.discord_json TEXT` (emoji, logo, do and
  don't lists, CTA options, payout note, important note, help text, apply link, and per-field "show publicly" switches).
  Additive, so old code keeps running.
- Admin campaign editor: a "Discord post" section with the switch, one shared validator (lengths, https-only URLs, list sizes,
  Discord's embed limits) used by both the form and the route.
- Sanitising: markdown and `@` neutralised, `<#channel>` allowed only in the help text.
- **Tests first:** validator table (good, too long, bad URL, script tags, mentions); route refuses bad input with a 400; existing campaign
  create and edit tests unchanged; delete-integrity test extended.
- **Prove:** fill in one campaign, nothing appears anywhere yet. **Undo:** columns are ignored by old code.

### Phase 7. Extend `GET /api/bot/campaigns`
- With `BOT_FORUM: "off"`, the endpoint is byte-for-byte what it is today.
- With it `on`: list every campaign with `discord_publish = 1`, any status, with the documented fields. Status is sent
  **normalised** (`live` / `paused` / `over`): active → live, budget_full → paused, completed → over (D4).
  `budget_total` and `budget_consumed` use the same numbers the clipper dashboard shows. `clippers_enrolled` counts joined,
  not removed, clippers. `max_payout_per_video` comes from the campaign's cap.
- Never included: clipper names or earnings, client or agency details, fee percentages, internal notes, and footage or reference
  links unless the per-campaign switch is on.
- **Tests first:** a privacy test that scans the whole response for anything not on the allow-list; ordering is stable; a campaign
  that is unpublished disappears; a completed one stays as `over`; text fits Discord's limits; contract fixtures shared with the bot.
- **Prove:** with the bot's forum sync off, fetch the endpoint by hand and read it line by line.
- **Requires** the phase 0 bot change to be deployed, or finished campaigns would show as open in the campaign list.

### Phase 8. The doorbell
- Migration **054**: `bot_sync_state` (last hash sent, pending-since, last ring, last success, last error).
- `requestCampaignSync(env)`: builds the forum-visible view of every published campaign in one grouped query and hashes it (budget
  in 1% steps). If the hash equals the last one sent, do nothing. Otherwise enqueue **one** delayed ring; further changes while it is
  pending add nothing (the bot re-reads everything anyway). The consumer clears the pending mark *before* calling the bot, so a change
  during the call rings again and no update can be lost.
- Called after: campaign create, edit and delete; publish switch; join and kick; and at the end of each refresh step and every hourly
  run as a safety net.
- **Tests first:** 50 joins in a minute cause at most two rings; a change smaller than 1% of budget rings nothing; a status change rings;
  nothing changed rings nothing; key order does not change the hash; a bot outage never fails the admin edit; a change during an
  in-flight ring is not lost; hourly safety net rings after a missed ring.
- **Prove:** publish one test campaign, edit it, and watch the thread appear and change within seconds.
- **Undo:** `BOT_FORUM: "off"`.

### Phase 9. Resilience extras (optional, after real use)
- DM fallback through Discord directly after ~10 minutes of the bot being unreachable (D9), and the welcome DM after a fresh join (D6).
- Admin "recent bot events" list, reading `bot_events`, for support.

### Phase 10. Go-live runbook (order matters)
1. Endrig pushes the listener and the phase 0 change; sends host, port and token privately.
2. We set `BOT_NOTIFY_URL` and `BOT_NOTIFY_TOKEN` as secrets. **Check bot** green. **Send test DM** received.
3. Flip `BOT_NOTIFY` on. Watch `bot_events` and the Error Log for a day.
4. Publish **one** campaign; flip `BOT_FORUM` on; confirm the thread; then publish the rest.

---

## 8. Exceptions and edge cases: what happens, and where it is tested

| Situation | Behaviour |
|---|---|
| Bot down or unreachable | Event waits in the queue and retries for up to 24 h; website unaffected; one quiet Error Log entry per 30 minutes, not one per event |
| Bot slow | 6-second cut-off, then retry |
| Wrong token (401) | Alert once, slow retry; nothing sent to anyone else |
| Bot rejects our payload (400) | Recorded with the bot's message, not retried; this is our bug and shows in the admin |
| Bot error (5xx) | Retry with backoff |
| Same event sent twice | Stable `event_id` on every event; the bot drops repeats for 30 minutes |
| Queue send itself fails | Recorded; the action that caused it still succeeds |
| Clipper has no linked Discord | Recorded as skipped (visible to support); never an error |
| Clipper archived or deleted | No DM |
| Clipper has DMs closed | Only the bot can see this. Known gap in the documents; raised with Endrig |
| Very long or hostile reviewer text | Cut to the limits, markdown and `@` neutralised |
| Campaign deleted or unpublished | It leaves the list; the thread stays until the bot archives it (D7) |
| 100+ joins at once at a campaign launch | Coalesced to a few rings |
| Missed ring | The bot's own hourly poll plus our hourly safety-net ring |
| Token or URL missing | Everything is a silent no-op; **Check bot** says exactly what is missing |
| Plain HTTP | Works, but the admin page warns |

## 9. Telemetry and root-cause readiness

- `bot_events`: one row per event with status (`queued` → `sent` / `retrying` / `gave_up` / `skipped`), attempts, last error, timestamps.
  Answers "was this person told, and if not, why?" in one query.
- Error Log codes (the admin page already badges new entries): `BOT_UNREACHABLE`, `BOT_UNAUTHORIZED`, `BOT_PAYLOAD_REJECTED`,
  `BOT_DELIVERY_GAVE_UP`, `BOT_QUEUE_FAILED`.
- **Check bot** panel: configured, HTTPS, reachable, token accepted, last success, failures in the last 24 hours, last ring.
- Every retry is logged with its attempt number, and never with the token.

## 10. How we test, in every phase

1. Tests are written before the code, against the fake bot and the contract validator.
2. Real-schema SQLite tests, as everywhere else, plus the existing hostile-input, delete-integrity and page-syntax sweeps (they pick up new
   routes and pages automatically).
3. Every payload must pass the contract validator, so if Endrig's rules change we find out in `npm test`.
4. A local end-to-end run: the Worker under `wrangler dev` with the fake bot on localhost, exercising the real queue path.
5. Then production, inert, then one real event to a teammate, then on.

## 11. Release and rollback protocol

- One phase per commit and deploy, tagged `checkpoint/N`, pushed. `npm test` green first.
- Migrations are additive (new table, new nullable columns) and applied to production **before** the deploy.
- Undo, in order of speed: delete the secret (seconds), flip the valve and deploy, redeploy the previous tag. The database never needs
  rolling back.

## 12. Not in this batch

- **Referral push** (`POST /api/internal/referrals`, bot → website), still approved but unbuilt.
- Telling the bot about payout reversals or campaign completion messages beyond the forum status.
- Discord as a login method (decided against earlier: usernames and passwords stay the only way in).
