# Bot Discord-link webhook contract

Direction: **website → bot**. Called once, right after a clipper finishes the
"Connect to Discord" flow on the dashboard, to add them to the ClipGrow Discord
server using the consent they just gave.

Shares the same listener, port and token as `docs/bot-notify-contract.md` — just
a different path. See `docs/README.md` for the full picture of all three
website↔bot contracts.

## What happens before this call (website side, not the bot)

1. Dashboard's "Connect to Discord" button sends the user to:
   ```
   https://discord.com/oauth2/authorize
     ?client_id=<CLIENT_ID>          (same CLIENT_ID as the bot's — it's one Discord app)
     &redirect_uri=<your callback>
     &response_type=code
     &scope=identify guilds.join
   ```
2. Discord redirects back to your callback with `?code=...`.
3. Your server exchanges that code for an access token at
   `POST https://discord.com/api/oauth2/token` (needs a `DISCORD_CLIENT_SECRET` —
   this lives on the website, the bot never sees it).
4. Call `GET https://discord.com/api/users/@me` with that access token to get the
   permanent Discord user id. Save it against the clipper's account — this is the
   same id used everywhere else (`/mystatus`, referral linking, `/notify`).
5. **Now** call the bot, below, with that same access token, so the bot can
   actually add them to the guild.

The `guilds.join` scope is what makes step 5 possible — without it, Discord will
reject the add in step 5 no matter what.

## Endpoint

```
POST http://<bot-host>:<NOTIFY_WEBHOOK_PORT>/link
Authorization: Bearer <NOTIFY_WEBHOOK_TOKEN>
Content-Type: application/json
```

```json
{
  "discord_user_id": "111111111111111111",
  "access_token": "the user's OAuth access token from step 3, with guilds.join"
}
```

Both fields required. The access token only needs to live long enough for this
one call — the bot doesn't store it.

**Never invent or hardcode the host, port, or token** — get the real ones from
the bot side and read them from env vars.

Try it by hand once you have a real `access_token` (from completing the OAuth
flow above with `guilds.join` in the scope) and a real `discord_user_id`:

```bash
curl -i -X POST http://<bot-host>:<NOTIFY_WEBHOOK_PORT>/link \
  -H "Authorization: Bearer <NOTIFY_WEBHOOK_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"discord_user_id":"111111111111111111","access_token":"<real OAuth access token>"}'
```

## Response

- `200 { "ok": true, "joined": true, "alreadyMember": false }` — added to the guild just now.
- `200 { "ok": true, "joined": false, "alreadyMember": true }` — they were already
  a member (e.g. reconnecting); nothing to do, not an error.
- `400 { "ok": false, "error": "bad_snowflake" | "bad_access_token", "message": "..." }` — bad request shape.
- `400 { "ok": false, "error": "discord_rejected", "message": "..." }` — Discord
  refused the join. Almost always means the access token expired or was requested
  without `guilds.join` — have the user reconnect.
- `401 { "ok": false, "error": "unauthorized" }` — bad or missing bearer token.
- `500 { "ok": false, "error": "guild_unavailable" }` — the bot isn't in the guild
  it's configured for; a bot-side config problem, not yours.
- `502 { "ok": false, "error": "discord_error" }` — Discord's API had a problem;
  safe to retry.

On a fresh join, the bot also sends the clipper a short welcome DM. That's best-
effort — if their DMs are closed it's logged, not reported back to you, and does
not affect the response above.
