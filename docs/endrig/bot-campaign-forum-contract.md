# Bot campaign-forum contract

Direction: mostly **bot ← website** (the bot reads campaign data), with one small
**website → bot** doorbell to say "go look now."

Replaces staff hand-posting a forum thread per campaign (like the BE10x one) with
the bot keeping one thread per campaign automatically in sync — created, edited,
renamed and tagged from the same campaign data the website already exposes for
`/mystatus` and the campaign list, extended with the fields below.

See `docs/README.md` for the full picture of all three website↔bot contracts.

## How it works

1. The bot already polls `GET /api/bot/campaigns` (same endpoint the campaign
   list feature uses) as a safety net, every ~60 minutes by default.
2. **Whenever a campaign is created, or ANYTHING about it changes** — budget
   consumed, a clipper joins, status flips to paused/over, staff edits the
   brief, anything — call the bot's doorbell (below). The bot re-reads the full
   campaign list and syncs it within seconds. The poll in step 1 only exists in
   case a doorbell call is ever missed; it is not the primary update path, so
   don't worry about "is 60 minutes fast enough" — it's a fallback, not the
   mechanism clippers actually notice.
3. Each campaign gets exactly one thread for its whole life. The bot edits it in
   place — new thread only the first time a campaign id is seen.

## 1. Extend `/api/bot/campaigns`

Today each campaign in the `campaigns` array looks like:

```json
{ "id": 1, "name": "Reel Rush", "cpm": 55, "min_views": 1000, "platforms": ["instagram", "youtube"] }
```

Add these fields (all optional — anything missing is simply left out of the
post rather than breaking it, but the more you send, the closer the post
matches the manual format you're replacing):

| field                    | type            | shows up as                                    |
|--------------------------|-----------------|-------------------------------------------------|
| `status`                 | string          | `live` (default) / `paused` / `over`\* — drives the thread's tag and whether it gets locked+archived (also shown as text in the title, e.g. `(LIVE)`) |
| `emoji`                  | string          | the leading emoji in the thread title and embed — pick whatever fits the campaign's vibe (🎙️ for a podcast, 🎵 for music, 🎮 for gaming, ...). Defaults to 📋 if omitted. This is about the campaign's *content*, not its status — status already shows via `(LIVE)`/`(PAUSED)`/`(OVER)` and the tag |
| `logo_url`               | string (URL)    | the brand/campaign logo, as the post's thumbnail image — **this field doesn't exist yet, please add it** |
| `budget_total`           | number          | "Total Clipper Budget"                           |
| `budget_consumed`        | number          | used with `budget_total` to show "Budget left: X/Y" |
| `clippers_enrolled`      | number          | "Clippers" count in the summary line             |
| `max_payout_per_video`   | number          | "Max payout per video"                           |
| `cta`                    | string[]        | numbered CTA options ("use one of —")            |
| `payout_note`            | string          | e.g. "Payouts are calculated only on approved, verified views." |
| `source_footage`         | string          | the source-footage description                   |
| `source_footage_link`    | string (URL)    | link to the raw footage                          |
| `dos`                    | string[]        | numbered "Do" list                               |
| `donts`                  | string[]        | numbered "Don't" list                             |
| `important_note`         | string          | the "⚠️ Important" callout                        |
| `inspiration_links`      | string[]        | "Need Inspiration?" links                         |
| `help_text`               | string          | "Need Help?" text (can include your own Discord channel mentions as plain `<#channel_id>` text) |
| `apply_url`              | string (URL)    | where the "Apply to become a clipper" button goes — falls back to `https://clipgrow.in/dashboard` if omitted |

\* any of `paused`/`pause`/`on_hold`/`hold` → shown as **PAUSED**; any of
`over`/`closed`/`ended`/`complete`/`completed`/`finished` → shown as **OVER**
(thread gets locked and archived, nothing deleted); anything else (including
missing) → **LIVE**.

`id` must stay stable for a campaign's whole life — it's the only way the bot
knows "this is the same campaign, edit its thread" instead of creating a
duplicate.

## 2. The doorbell: `POST /campaign-sync`

```
POST http://<bot-host>:<NOTIFY_WEBHOOK_PORT>/campaign-sync
Authorization: Bearer <NOTIFY_WEBHOOK_TOKEN>
Content-Type: application/json

{ "campaign_id": 42 }
```

Same port and token as `/notify` and `/link` — nothing new to configure.
`campaign_id` is optional and only used for logging; the bot always re-fetches
and syncs the full campaign list, not just one campaign, so an empty body
(`{}`) works fine too. Call it after ANY change to ANY campaign, not just on
creation — don't try to special-case "is this worth a sync," just always ping
it.

Response is always `202 { "ok": true, "triggered": true }` (or `200
{ "ok": true, "triggered": false, "reason": "not_configured" }` if the bot's
forum sync isn't turned on yet) — it does not wait for the sync to finish, so
don't expect the Discord post to exist yet by the time this call returns.

**Never invent or hardcode the host, port, or token** — get the real ones from
the bot side and read them from env vars.

Try it by hand once `/api/bot/campaigns` is returning at least one campaign
with the new fields:

```bash
curl -i -X POST http://<bot-host>:<NOTIFY_WEBHOOK_PORT>/campaign-sync \
  -H "Authorization: Bearer <NOTIFY_WEBHOOK_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Then check the forum channel in Discord a few seconds later for the new/updated
thread.

## What the post looks like

Two messages in one thread, per campaign:

1. **Starter message** (plain text — this is what Discord shows as the post's
   preview in the channel list): `CPM: ₹70 per 1,000 verified views | Budget
   left: ₹32,400/₹50,000 | Clippers: 14 | Status: 🟢 LIVE`
2. **A follow-up embed**: the full brief (everything from the table above),
   the campaign logo as a thumbnail, and an "Apply to become a clipper" button
   linking to `apply_url`.

The thread's title is `<emoji> <campaign name> (<STATUS>)`, and (once the bot
creates them on first run) a matching LIVE/PAUSED/OVER tag is applied too.
