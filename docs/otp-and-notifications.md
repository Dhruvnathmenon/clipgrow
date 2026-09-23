# Phone/email verification (OTP) and notifications — what we looked into

Written 24 Sep 2026. Research only: nothing here is built, because each option needs
an account or a secret that only the founder can create. Prices and limits are from
provider pages read on the day; check them before signing anything.

## 1. What OTP would actually buy us

One account per email, phone and Discord is already enforced (checkpoint 20), on a key
that collapses Gmail dots, `+tags`, `+91` numbers and Discord case. What that does **not**
prove is that the number or email belongs to the person typing it. Two real gaps:

- **Fake or mistyped numbers.** Someone enters `9876500001`. It passes every format check.
  We only find out when a WhatsApp message to it goes nowhere.
- **Squatting.** Because each detail is unique, a person can register a victim's email or
  number first, and the victim is then told "already used" when they try to sign up. Cheap
  to do, annoying to fix. Verification is the only real cure: an unverified claim would not
  count.

What already carries most of the weight without OTP: a Discord account verified through
Discord itself (unique per account, and once `DISCORD_LINK=required` nobody gets past step
one without it), the per-address sign-up limit, and the video review before anyone can earn.

## 2. The options, priced

| Option | Proves | Cost (India) | Setup effort | Who has to act |
|---|---|---|---|---|
| **Email code** via Cloudflare Email Service | the email is theirs | 3,000 emails/month included on the Workers Paid plan, then $0.35 per 1,000 | Small. A `EMAIL` binding and a verified sending domain. Service is in **beta**. | Founder: enable Email Sending for `clipgrow.in` |
| **WhatsApp code** (Meta authentication template) | the number is theirs **and reachable on WhatsApp**, which is how ClipGrow contacts people | about ₹0.115 per delivered code, the same on every reseller | Meta business verification, a WhatsApp Business account, an approved template, usually through a reseller. Days to weeks. | Founder: business verification and reseller account |
| **SMS code** via an Indian provider (MSG91, Fast2SMS and similar) | the number is theirs | about ₹0.15 to ₹0.25 per SMS. Own DLT registration is about ₹5,000 to ₹5,900 once and takes 7 to 21 working days. A provider's shared templates let you start at once. | Small once a provider account exists | Founder: provider account and API key |
| **Discord only** (today) | a real Discord account | free | done | nobody |

Two things worth knowing about those numbers:

- **A thousand sign-ups a month costs about ₹115 on WhatsApp.** The money is trivial. The
  real cost is the setup and compliance time, so pick by lead time, not price.
- **A vendor blog claims OTP "bypasses" DLT.** It does not. What is true is that a provider
  can send OTPs under its own already-registered sender and templates while yours is in
  progress. Do not sign up believing DLT does not apply to you.

## 3. Recommendation

1. **Cloudflare Turnstile on the sign-up form.** Free, an afternoon, and it stops most script
   traffic before it ever reaches the limits. Do this whatever else is decided.
2. **WhatsApp code for the phone number.** It is the only option that verifies the channel we
   actually use to reach and pay people. Start Meta verification now: it is the slow part, and
   nothing else depends on it.
3. **Email code** only if email becomes something we rely on. Today it is a contact detail
   nobody is messaged on, so verifying it buys little.
4. Until then, keep sign-up **closed**, or open only with `DISCORD_LINK=required` so every
   new account has a verified identity from day one.

## 4. How it would be built (so it is ready when a provider exists)

- A table of challenges: target, a **hash** of the six-digit code (never the code), attempts,
  expiry, address hash. Ten-minute expiry, five wrong tries and it is dead.
- Resend uses the same doubling wait as everything else (`src/backoff.js`), plus a per-target
  and per-address ceiling. A code endpoint that anyone can call is an SMS-bombing tool
  unless it is capped.
- Sign-up becomes two steps: details, then the code, and the account is only created after
  it. Every self-made account is then verified by construction.
- New columns `phone_verified_at` and `email_verified_at`. Accounts made before this stay as
  they are, and are asked to verify on next login.
- The provider is behind one function, so changing vendor is a one-file change.

## 5. Notifications

There is nothing to look into first: the hard part already exists.

- **Discord DMs** are built (`sendDirectMessage`, used by the unused-account warning). They
  need only the bot token, not the bot process, so they work while the bot host is down.
  They are best effort by nature: the person must share a server with the bot and must not
  have closed DMs.
- **In the dashboard** there is nothing yet. It should come first, because it is the only
  channel that cannot fail: a small inbox of what happened, on the page people already open.
- **Email** follows the OTP decision above.
- **WhatsApp messages** (not just codes) are possible on the same account as the WhatsApp OTP.
  Utility messages are billed separately, so decide which events deserve one.

Proposed shape: one function, `notify(clipper, event, details)`, that always writes the
dashboard inbox row (the record) and then fans out to the other channels through the queue,
never inline in a request. Delivery failures go to the Error Log, not to the person.

The events worth sending first, in order of how much they save the team:

1. Video approved or rejected (with the reviewer's note). This ends "did anyone see mine?"
2. Account request approved or rejected.
3. Payout sent.
4. Unused-account warning (already done, on Discord).
5. A clip removed or flagged.

Rules that keep it from becoming noise: one message per event, a dedupe key so a retry never
sends twice, nothing between 11pm and 8am IST unless it is money, and a way to turn each kind
off from the dashboard.

## 6. What is needed from the founder

- Say whether to start Meta business verification for WhatsApp now.
- Say whether to enable Email Sending for `clipgrow.in` in Cloudflare (Workers Paid plan
  needed for arbitrary recipients; the account already uses Queues, which needs it).
- Nothing can be built for OTP until one provider account exists and its key is stored as a
  Worker secret. Passwords and keys are never entered by Claude.

Sources: [Cloudflare Email Service](https://developers.cloudflare.com/email-service/), its
[pricing page](https://developers.cloudflare.com/email-service/platform/pricing/),
[DLT guide](https://www.messagecentral.com/blog/a-complete-guide-on-dlt-registration),
[MSG91 OTP pricing](https://msg91.com/in/pricing/otp),
[WhatsApp OTP cost in India](https://messagebot.in/blog/whatsapp-otp-service-india/).
