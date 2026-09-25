# Bot notify webhook contract

Direction: **website → bot** (the reverse of `docs/bot-api-contract.md` on the
website side, which is bot → website). The website calls this whenever something
happens that a clipper should be DM'ed about — a clip approved or rejected, a
payout sent, or anything else worth telling them directly.

See also `docs/bot-link-contract.md` (connecting a Discord account + auto-join)
and `docs/bot-campaign-forum-contract.md` (auto-posted campaign forum threads) —
same listener, same port and token, different paths.

## Endpoint

```
POST http://<bot-host>:<NOTIFY_WEBHOOK_PORT>/notify
Authorization: Bearer <NOTIFY_WEBHOOK_TOKEN>
Content-Type: application/json
```

Both env vars are set on the bot's side; the website just needs to be given the
port/URL and the token out of band. If the token doesn't match, or `Authorization`
is missing, the bot returns `401` and nothing is sent.

**Never invent or hardcode a value for the host, port, or token** — get the real
ones from the bot side (ClipGrow's Discord bot maintainer) and put them in this
project's env vars. If they're not available yet, wire the code up to read them
from env and leave a clear note that they still need to be filled in.

Try it by hand once you have the real values:

```bash
curl -i -X POST http://<bot-host>:<NOTIFY_WEBHOOK_PORT>/notify \
  -H "Authorization: Bearer <NOTIFY_WEBHOOK_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"type":"submission_approved","discord_user_id":"111111111111111111","campaign":"Test Campaign","views":1000}'
```

A real Discord user id is needed to actually see a DM land — ask a teammate for
theirs to test with (their Discord profile → "Copy User ID", with Developer Mode
on in Discord's settings).

## Request body

One event per request:

```json
{
  "event_id": "submission_8231_approved",
  "discord_user_id": "111111111111111111",
  "type": "submission_approved"
}
```

- `discord_user_id` (required) — the clipper's Discord user id (snowflake). This
  is the same id the website already stores for `/mystatus` and referral linking.
- `type` (required) — one of `submission_approved`, `submission_rejected`,
  `payout_sent`, `custom`. Extra fields depend on the type (below).
- `event_id` (optional, recommended) — any stable string identifying this event
  (e.g. `submission_<id>_approved`). If a request with the same `event_id` arrives
  again within 30 minutes, the bot silently drops it instead of DMing the person
  twice. Safe to always send this and retry on timeout without worrying about
  double notifications.

### `submission_approved`

| field       | required | notes                                  |
|-------------|----------|-----------------------------------------|
| `campaign`  | yes      | campaign name                           |
| `platform`  | no       | e.g. `"YouTube"`, `"Instagram"`         |
| `views`     | no       | number                                  |
| `clip_url`  | no       | link to the approved clip               |

### `submission_rejected`

| field           | required | notes                                  |
|-----------------|----------|------------------------------------------|
| `campaign`      | yes      | campaign name                            |
| `reason`        | yes      | shown to the clipper directly — keep it clear and actionable |
| `resubmit_url`  | no       | where to submit a fixed version          |

### `payout_sent`

| field         | required | notes                              |
|---------------|----------|-------------------------------------|
| `amount_inr`  | yes      | number, no currency symbol          |
| `campaign`    | no       |                                      |
| `method`      | no       | e.g. `"UPI"`, `"Bank transfer"`     |
| `note`        | no       | free text                           |

### `custom`

Escape hatch for anything that doesn't fit the above, so a new kind of
notification doesn't require a bot code change:

| field         | required | notes                              |
|---------------|----------|-------------------------------------|
| `title`       | yes      | max 256 chars                       |
| `description` | yes      | max 4096 chars, supports Discord markdown |
| `color`       | no       | hex string or number, e.g. `"#5865f2"` |

## Response

The bot validates and queues the notification synchronously, then delivers it
asynchronously (see "Batching" below) — the response does not mean the DM has
landed yet, only that it was accepted.

- `202 { "ok": true, "queued": true, "duplicate": false }` — accepted.
- `202 { "ok": true, "queued": false, "duplicate": true }` — dropped as a repeat
  of a recent `event_id`. Not an error.
- `400 { "ok": false, "error": "bad_request", "message": "..." }` — bad payload;
  `message` says exactly what's wrong.
- `401 { "ok": false, "error": "unauthorized" }` — bad or missing token.
- `404` / `405` — wrong path or method (only `POST /notify` exists).
- `500 { "ok": false, "error": "server_error" }` — something broke on the bot's
  side; safe to retry.

There is currently no callback for "the DM failed to send" (e.g. the clipper has
DMs closed to this server) — that's logged on the bot's side for a moderator to
notice, not reported back to the website. Worth revisiting if this becomes a real
UX gap for clippers who never see their notifications.

## Batching

If several events for the same `discord_user_id` arrive within ~2.5 seconds of
each other, they're delivered as **one DM with multiple embeds** instead of
several separate messages — useful for bulk review passes or payout runs.
Nothing the website needs to do differently; just send one request per event.
