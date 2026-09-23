# ClipGrow bot API — contract

The one door the Discord bot (Clipcore) uses to ask the ClipGrow website anything.
The website never calls the bot; the bot only ever makes these requests. If the bot
is down, nothing on the website changes.

Code: `src/bot-api.js` (website) and `src/utils/clipgrowApi.js` (bot).
Tests on both sides run against the same answers: the bot's fixtures in
`test/fixtures/` are generated from the real website handler, so a change here that
the bot does not expect fails the bot's tests.

## Rules that do not bend

- **A closed list of questions.** The bot picks from `INTENTS` and names only which
  Discord account is asking. No field to select, no query, no way to name someone else.
- **The website writes the sentences.** The bot prints `lines` verbatim.
- **No money, ever.** No earnings, budgets, spend, balances or payouts, in any answer.
  Those stay on the dashboard.
- **Nothing about anyone but the asker.** Not another clipper's name, status or
  handle; not a reviewer's note; not a video link; not contact or payment details.
- **A leaked token is worth little and is noticed.** It can read coarse status for
  linked clippers, and unusual volume is refused and reported (see Limits).

## Auth

Every request: `Authorization: Bearer <BOT_API_TOKEN>`. The token is a Worker secret
on the website and `CLIPGROW_BOT_TOKEN` in the bot's environment; they must match.
With no `BOT_API_TOKEN` set the whole API answers `503 bot_api_disabled`.

Rotate: `npx wrangler secret put BOT_API_TOKEN` here, change `CLIPGROW_BOT_TOKEN`
there, restart the bot. Until both match the bot gets `401` and tells people it is
not connected; nothing else is affected.

## Endpoints

### `GET /api/bot/ping`
`200 { "ok": true, "at": <ms> }`. For "is the wiring right".

### `GET /api/bot/campaigns`
Open campaigns, newest first, in the shape the public website already shows.

```json
{ "campaigns": [ { "id": 1, "name": "Reel Rush", "cpm": 55, "min_views": 1000,
                   "platforms": ["instagram", "youtube"] } ], "at": 1789000000000 }
```
Exactly those five fields. Never budget, spend, description or client details.
No open campaigns is `{ "campaigns": [] }`, not an error.

### `POST /api/bot/answer`
```json
{ "discord_user_id": "111111111111111111", "intent": "status" }
```
`discord_user_id` is a string of 15 to 25 digits. `intent` is one of `INTENTS`.

Answer, always `{ "linked": bool, "lines": [string, ...] }`:

- **Linked:** where they stand (details complete or what is missing, one line per
  campaign with the next step, how many other campaigns are open, the dashboard link).
- **Not linked** (or an archived account, which looks the same): a pointer to
  Connect Discord. It says nothing about anyone.

Names in `lines` are already escaped (markdown, and `@` cannot form a mention).

## Errors

Always JSON, never an HTML page: `{ "error": "<code>", "message": "<words>" }`.

| Status | `error` | Meaning | The bot tells people |
|---|---|---|---|
| 400 | `bad_request` | Body not a JSON object, or `discord_user_id` is not digits | "something went wrong" |
| 400 | `unknown_intent` | Not on the list | "something went wrong" |
| 401 | `unauthorized` | Missing or wrong token | "isn't connected to ClipGrow yet" |
| 404 | `not_found` | No such endpoint | "something went wrong" |
| 405 | `method_not_allowed` | Wrong verb | "something went wrong" |
| 429 | `rate_limited` | Volume breaker | "try again in a few minutes" |
| 500 | (router) | Unexpected failure, logged to the admin's error log | "couldn't reach ClipGrow" |
| 503 | `bot_api_disabled` | No token configured | "isn't connected yet" |

The bot has a 6 second timeout on every request. Timeouts, refused connections and
non-JSON answers are all treated as "couldn't reach ClipGrow".

## Limits

Ten minutes, all callers together: more than **600 calls** or **150 different people**
and the API answers `429` until the window slides on, and writes one `bot_api`/`VOLUME`
entry to the admin's Error Log ("the token may have leaked: rotate it"). Normal use
is a small fraction of this. Constants: `BOT_LIMITS` in `src/bot-api.js`.

The call log (`bot_api_calls`) holds a salted hash of each Discord id, never the id,
and is pruned after a day. **Check Discord** in the admin Campaigns tab shows whether
the API is on and when the bot last called.

## Adding a question

1. Add it to `INTENTS` and write its answer in `src/bot-api.js`.
2. Add tests beside the "no money, anywhere" and "only them" tests.
3. Regenerate the bot's fixtures and add the bot-side handling.
4. Deploy the website first, then the bot. The bot cannot add a question on its own.
