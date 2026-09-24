# What changed, how the website and the bot fit together, and what was checked

Written 24 Sep 2026, at the end of a long working session. This is meant to be read
top to bottom by a person, not a programmer. Nothing here needs you to run anything.

---

## 1. The short version

- **Four things you asked for on the clipper dashboard are done and live**: back-off on
  retries, deleting your own account (plus clearing out unused ones), a page showing which
  moderator approved which video, and the Step 3 tile removed.
- **Sign-up now asks for email, phone and Discord**, and the database refuses a second
  account with the same one, even if it is written a different way.
- **Sign-up itself is still closed.** So is Discord linking. Nobody new can join yet. That
  was deliberate, and it is a one-line change per switch when you are ready.
- **The website and the Discord bot are wired to each other but mostly switched off.** The
  one thing that really flows today is the live Paid / Views numbers in the two Discord
  channels. Section 4 is the full picture.
- **Everything is saved in GitHub with a bookmark after each step**, so any step can be
  undone on its own (section 3).
- **The one duplicate account was removed at your request** (section 7). Every remaining
  account is now unique.

---

## 2. What changed, in plain words

### A. Which moderator approved which video (admin page)

- New tab **Video Applications**.
- Top table: one row per reviewer with **Approved**, **Rejected**, **Approval rate**, and
  **Approved, later removed**. The last one counts approvals where that person was later
  kicked from the campaign or had their account turned off. It is the number to look at
  if the wrong people are getting in. Click a row to see only that reviewer.
- Below it: every verdict, newest first, with the reviewer's note and where the clipper
  stands today (connected, not connected yet, removed, account disabled or deleted).
- The 76 approvals carried over automatically when video review started are left out of
  the totals, because nobody reviewed them.

### B. Step 3 removed

- The clipper's campaign page now shows two steps (Video review, Connect your account).
  I removed the whole third tile, not only the words "Post & earn". If you wanted the tile
  kept under another name, that is a small change.

### C. Waiting longer after each rejection (retry back-off)

- After a rejected video, the clipper waits **1 hour**, then **2**, then **4**, up to a
  maximum of a day. Counted from the moment of the rejection, so a slow reviewer never adds
  to it.
- The clipper sees the reason and a live countdown. A clipper who has never been rejected
  is not slowed at all.
- Uploading a file first does not get round it: the upload is refused during the wait too.
- The same rule applies when the team rejects an Instagram or YouTube account request.
  People already rejected before today are not made to wait.
- A video still allows three attempts per campaign. That has not changed.

### D. Deleting an account, and clearing out unused ones

**A clipper deleting their own account**
- Buttons: **Delete Account** in the sidebar, and **Delete my account** inside Your Details.
- It explains what happens, asks for their password, and needs a tick box.
- **It is refused while they are still owed money** (or owe an advance), and says why before
  they type anything.
- On deletion: they are logged out for good, their username, email, phone and Discord name
  become free for anyone else, connected Instagram/YouTube accounts are disconnected, and
  their personal details are erased. **Records of payments already made are kept**, and if
  they were ever paid, their UPI and legal name are kept too, because a payment record with
  no name on it cannot be audited.

**Unused accounts, cleared automatically**
- An account counts as unused only if it has done nothing at all: no connected account, no
  clip, no payment, no video in review or approved, no account request in progress, and it
  has not been opened for 30 days.
- Each one gets a **Discord message** warning it, and is removed **14 days later** if it is
  still unused. A visit in between cancels the warning.
- Safety rules: an account is only removed if the warning actually arrived; an account nobody
  can warn is never removed (it is listed for you instead); at most 25 warnings and 25
  removals per day; and everything removed is written to the audit log.
- **New admin panel** at the bottom of the Clippers tab, **Unused accounts**, shows where each
  one stands and has **Keep** (never touch this one) and **Delete now** buttons.
- **Important:** today nobody has linked Discord (0 of 60), so no warning can be sent and
  **nothing will be removed**. Every account's 30-day clock also started at deploy, so the
  earliest anything could be warned is late October. Seven accounts are unused right now.

### E. One account per email, phone and Discord username

- The sign-up form now asks for **email, phone number and Discord username** as well as a
  username and password. Each shows its own message under its own box. (Payout details are
  still asked for on first login, as before.)
- The database holds these three **unique**, and it compares a **normalised form**, not
  the typed text:
  - `n.a.m.e@gmail.com`, `name+2@gmail.com` and `name@googlemail.com` are all the same
    Gmail inbox.
  - `+91 98765 43210`, `098765 43210` and `9876543210` are the same phone.
  - `@RAVI.K` and `ravi.k` are the same Discord name.
- This applies at sign-up, when a clipper edits their own profile, and when an admin edits
  it. An account that has been deleted no longer holds its details.
- Being told "already used" counts against that internet connection's sign-up limit, so the
  form cannot be used to probe which emails or numbers have accounts.
- If you restore an archived account whose email was taken in the meantime, it now says so
  instead of failing.

### F. Notes and research
- Project notes and the change log were updated.
- `docs/otp-and-notifications.md` holds the OTP (verified phone number) and notification
  research. Short version: use Cloudflare Turnstile on the sign-up form now (free), start
  Meta business verification for WhatsApp codes (about ₹0.115 each), and add a dashboard
  inbox as the notification channel that cannot fail. Nothing there is built, because each
  option needs an account or key that only you can create.

---

## 3. The database changes, and how to undo any step

Three changes, each applied to the live database **before** the code that needs it went out
(the order the project rules require), and each checked afterwards.

| # | File | What it adds | Checked in the live database |
|---|---|---|---|
| 049 | `migrations/049_retry_backoff.sql` | how many times, and when, an account request was rejected | 2 columns present; the 28 old rejected requests were back-filled so nobody waits retroactively |
| 050 | `migrations/050_account_lifecycle.sql` | last-seen date, warning date and channel, "keep this one", when and why an account ended | 6 columns present; all 60 live accounts had their clock started; the 9 already-archived accounts were tagged |
| 051 | `migrations/051_one_account_per_person.sql` | the three comparison keys and three "no duplicates" rules | 3 columns and 3 rules present; keys filled in for every live account that has the detail (41 emails, 41 phones, 40 Discord names), then all 60 re-checked against their stored details: 177 checks, 0 mismatches |

**Bookmarks in GitHub (any one can be returned to):**
`checkpoint/17-review-log`, `18-retry-backoff`, `19-account-lifecycle`,
`20-one-account-per-person`, `21-notes-and-research`. All are on the branch
`feature/clipper-platform`.

The three database changes only **add** columns and rules; they do not remove or rewrite
anything, so returning to an older bookmark of the code is safe against the current database.

**Live versions of the website**, in order: `f4caa51f` (17), `b89a3c91` (18),
`91ad3d9b` (19), `a01cd4d9` (20). Step 21 was notes only.

---

## 4. How the website, the bot, Pterodactyl and Discord interact right now

### The picture

```
   Discord servers (members, channels)
        ^   |
        |   |  live messages, slash commands, joins/leaves
        |   v
   THE BOT ("Clipcore")  -- runs on Pterodactyl (a game-hosting box), also runs the AI
        |                   helper (Ollama) on that same box, keeps its own small data files
        |
        |  it ASKS the website things (never the other way round)
        v
   THE WEBSITE (clipgrow.in, on Cloudflare) -- the real system: logins, dashboards,
        |                                       payouts, the database
        v
     Database (D1)

   Website --> Discord directly (no bot program needed): adding people to the server, and
   direct messages. Both are built but switched off. They need only the bot's key.
```

**The rule that protects the website:** the website never calls the bot and never waits
for it. If the bot's host crashes tonight, the website, logins, payouts and the database
carry on exactly as normal. Only the Discord conveniences stop.

### What is actually working today

| What | How it works | Status |
|---|---|---|
| **Paid / Views voice channels** in Discord | The bot asks `clipgrow.in/api/public/stats` every ~10 minutes and renames the two channels. No key needed, and the website returns the two numbers the bot reads. | **Live.** Website side checked by me today. Bot side is Andrig's report (I cannot see Pterodactyl). |
| **AI helper** (mention the bot and ask) | Runs inside the bot host with its own local model and reads two documentation files. It does not touch the website or any live data, by design. | **Live.** Its documentation files were still out of date when I last read them (they describe staff creating accounts by hand). Andrig said he would rewrite them; I saw no such change. |
| **Invite and referral tracking** | The bot watches who joined through which invite and keeps counts in its own files. Not connected to the website. | **Live**, separate from the website. Those files are no longer committed to GitHub (Andrig fixed that), so a code update cannot overwrite them. |

### Built on both sides, switched off

| What | Website side | Bot side | Why it is off |
|---|---|---|---|
| **/mystatus** (private answer to "where am I?") and a **live campaign list** channel | Built and tested (`/api/bot/...`), answers "not switched on" | Built and pushed to Andrig's repo | The website has no `BOT_API_TOKEN` yet, and the bot's two settings (`CLIPGROW_API_URL`, `CLIPGROW_BOT_TOKEN`) are blank. **The bot has never called the website: 0 calls recorded.** |
| **Connect Discord** on the clipper dashboard (adds them to the server) | Built and tested | not needed | `DISCORD_LINK` is `off` in `wrangler.jsonc`. The Discord keys already exist. |
| **Unused-account warnings** | Built | not needed | Needs someone with a linked Discord (none yet). |
| **Self-serve sign-up** | Built and tested | not needed | `CLIPPER_SIGNUP` is `off`. |

What /mystatus will show, once on: only the asker's own coarse status ("your video is with a
reviewer", "connect your account", and the like). **Never money, never another person's
details.** The bot cannot ask for anything outside a fixed list, and the website writes the
sentences; the bot only prints them. Asking about earnings in a channel gets a pointer to the
private command or the dashboard instead of an answer.

### Not built yet
- A place on the website for the bot's **referral snapshot** to land (the bot's sender exists,
  and has nowhere to send).
- Website-to-Discord messages such as "your video was approved" and "you were paid".
- A notification inbox on the dashboard.
- OTP codes.

### How a change to the bot actually reaches Discord
Per Andrig, the bot's host pulls the latest code from GitHub **when it restarts**, not the
moment code is pushed. So a push is safe (nothing changes until a restart), and a good push
also does nothing until someone restarts it.

---

## 5. What was tested and verified

### Automated tests
- **Website: 737 of 737 passing.** About 70 of them were written in this stretch and cover
  exactly the changes above:
  - reviewer log and "later removed" counts (6 tests)
  - back-off arithmetic, the screen's state, and the refusals (13)
  - deleting an account, the unused-account rules and the daily pass, including that
    nobody is removed who could not be warned (25)
  - one account per person: every disguised duplicate, the database rule itself, the
    profile and admin edits, restoring, and a test that reads the source and fails if any
    future code changes an email, phone or Discord name without updating its key (24)
- **Bot: 54 of 54 passing** (I ran them tonight), and **the website's bot-API tests: 26 of 26**.
- Existing tests that assumed "resubmit instantly after a rejection" and "sign up with only
  a username" were updated to the new rules rather than deleted.

### Checked in the live site
- Each of the four deploys went out only after its database change was in and confirmed.
- The new pages answer correctly when not logged in (`/api/admin/applications`,
  `/api/admin/dormant-accounts`, `/api/clipper/me/delete` all return "unauthorised", not an error).
- Homepage loads; `/api/public/stats` returns the numbers the Discord channels read.
- Sign-up reports **closed**.
- The live login page carries the three new fields. In a real browser I forced the form open
  and ran its checks: a mistyped email gets "Did you mean ravi@gmail.com?", a bad number and
  a bad Discord name each get their own message, corrected values pass, and there were **no
  errors in the browser console**.
- Live data, re-checked after the duplicate was removed: 59 live accounts; 0 duplicate emails,
  phones or Discord names (worked out again from the typed details, not just the stored keys);
  0 stored keys that disagree with their details.

### Not verified, and why you should know
- **The new admin panels and the Delete Account pop-up were not looked at on screen while
  logged in.** They need a login I do not have. They are covered by the automated tests and
  by the checks that every button points at a function that exists, but nobody has clicked
  them yet. Worth a 2-minute look tomorrow.
- **No real Discord message has ever been sent by this code.** The tests use a stand-in for
  Discord. The first real send will be the first true test.
- **The daily clean-up has not run in production yet.** It runs at 04:00 UTC (9:30 am India
  time). With 0 linked Discords it will warn and remove nobody.
- **I cannot see the Pterodactyl host**, so whether the bot has been restarted onto the
  newest code is unconfirmed.
- Two things I did not change and left as found: the untracked build files in the project
  folder (`assets/*.js`, `demo-onboarding.html`, `.agents/`).

---

## 6. Where things live (if you or Andrig need to find them)

| Thing | File |
|---|---|
| Deleting accounts, unused clean-up | `src/account-lifecycle.js` |
| Waiting after rejections | `src/backoff.js` |
| One account per person | `src/identity.js`, `components/profile-validation.js` |
| Reviewer log and scorecard | bottom of `src/applications.js`, route in `src/routes/admin.js` |
| Discord messages and joining | `src/discord.js`, `src/routes/discord-auth.js` |
| The bot's door into the website | `src/bot-api.js`, contract in `docs/bot-api-contract.md` |
| The two switches | `wrangler.jsonc` (`DISCORD_LINK`, `CLIPPER_SIGNUP`) |
| OTP and notification research | `docs/otp-and-notifications.md` |
| Proposal sent to Andrig | `docs/clipcore-integration-proposal.md` |

---

## 7. Waiting on you

1. **Done (24 Sep): `manu` removed, `ranjith` kept.** `manu` had no clips, payments or
   connected accounts, and two rejected videos. It was archived the same way the admin Delete
   does it, with its email, phone and Discord erased (they were identical to `ranjith`'s, so
   nothing was lost) so a restore cannot quietly bring the duplicate back. It is recorded in the
   audit log as `remove_duplicate_account`. Nothing on `ranjith` changed.
2. **Switch-on order, when you are ready** (each is one small change and one deploy, checked
   before the next):
   1. Set `BOT_API_TOKEN` on the website and the same value as `CLIPGROW_BOT_TOKEN` in the bot,
      plus `CAMPAIGN_LIST_CHANNEL_ID`. Restart the bot. This turns on /mystatus and the campaign list.
   2. Run **Check Discord** in the admin Campaigns tab. When everything is green, set
      `DISCORD_LINK` to `optional`, then later `required`.
   3. Only then set `CLIPPER_SIGNUP` to `open`.
3. **OTP and notifications:** decide on WhatsApp business verification and on Cloudflare Email
   Sending (details in `docs/otp-and-notifications.md`).
