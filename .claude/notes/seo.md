# SEO — full execution plan

Working doc for the SEO-dedicated chat. **Source of truth across
sessions — update it in place as steps land.** Check boxes as you go.

## The goal

Founder's words: show up **at the top** for —
- **"ClipGrow"** and anything branded — on every browser and every AI.
- **"clipping agency in India"**, **"clipping agency" + "India"** as
  keywords, **"what is clipping"**, **"clipping in India"**, and the
  whole surrounding cluster.
- Named engines: Google, Bing, Brave, Safari, Opera + Perplexity,
  ChatGPT, Grok, Gemini.

Status (2026-09-04): **"clipgrow" already ranks #1 on Google.** The
cluster head terms are a 6–12 month build gated by domain authority.
Main rival: **clipconnect.in**.

---

## How search actually reaches those browsers and AIs

There is **no per-browser SEO.** Every browser and AI pulls from one of a
small number of indexes. Win these and everything the founder named
follows:

| You optimise | Feeds |
|---|---|
| **Google index** | Chrome, Safari, Firefox, Opera, Samsung Internet, Vivaldi + **Google AI Overviews** + **Gemini** |
| **Bing index** | Edge, DuckDuckGo, Ecosia (partly) + **ChatGPT Search** + Copilot |
| **Brave Search index** | Brave browser (own independent crawler) |
| **Applebot** | Siri / Spotlight / Safari suggestions |
| **PerplexityBot** (+ Bing/Google) | Perplexity |
| **xAI crawler** (+ X/Twitter data) | Grok |

So the whole job is: **(1) be fully crawlable, (2) be in Google + Bing +
Brave, (3) allow the AI crawlers, (4) earn enough authority + citations
to rank.** Steps below are ordered low-effort → high-effort.

---

## Scoreboard (fill in during Tier 1, update monthly)

| Metric | Baseline (2026-09) | Latest |
|---|---|---|
| `site:clipgrow.in` indexed (Google) | _TBD_ | |
| Indexed (Bing) | _TBD_ | |
| "clipgrow" — Google / Bing / Brave | #1 / _?_ / _?_ | |
| "clipping agency in india" — Google | _TBD_ | |
| "what is clipping" — Google | _TBD_ | |
| Cited by ChatGPT for "clipping agency india"? | _TBD_ | |
| Cited by Perplexity? | _TBD_ | |
| PageSpeed mobile — `/` / `/for-clippers` / guide | _TBD_ | |

---

## TIER 1 — Low-hanging fruit (this week, low risk, big foundational value)

### Search-engine plumbing

- [ ] **1.1 Google Search Console** — add `clipgrow.in` as a Domain
  property, verify with the DNS TXT record (Cloudflare DNS). Submit
  `https://clipgrow.in/sitemap.xml`. *(founder, 15 min)*
- [ ] **1.2 Bing Webmaster Tools** — add the site, verify (or one-click
  "Import from Google Search Console"). Submit the same sitemap. This
  one console covers Edge, DuckDuckGo **and ChatGPT Search**. *(founder,
  15 min)*
- [ ] **1.3 Cloudflare → enable Crawler Hints / IndexNow** (dashboard →
  Caching → Configuration). Instantly notifies Bing, Yandex, Brave,
  Seznam whenever a page changes — so new guides get crawled in hours,
  not weeks. *(founder, 2 min)*
- [ ] **1.4 Cloudflare → AI crawler policy.** The `robots.txt` "Cloudflare
  Managed content" block currently disallows `GPTBot`, `Google-Extended`,
  `CCBot`, `ClaudeBot`, `Bytespider`, `meta-externalagent`. That keeps
  ClipGrow **out of ChatGPT and Gemini answers**. Decision needed:
  - **Recommended:** turn OFF "Block AI bots" (Cloudflare dashboard →
    Security → Settings, the AI-scrapers toggle) OR narrow it so
    `GPTBot`, `OAI-SearchBot`, `Google-Extended`, `PerplexityBot`,
    `Applebot`, and xAI's bot are **allowed**. The site is marketing copy
    + public guides — there is nothing to protect, and being quotable is
    the entire point.
  - Keep `Content-Signal: ai-train=no` if you want to signal "index and
    cite us, don't train on us" — it's advisory but honoured by the big
    players.
  - *(founder decides; this chat updates the repo `robots.txt` to match)*
- [ ] **1.5 Google Business Profile** — create it (Kerala, "service-area
  business", no storefront address shown). Category: *Marketing agency* /
  *Advertising agency*. This is the fastest brand-entity signal and is
  what builds the knowledge panel that locks the "clipgrow" query on
  Google **and** feeds Gemini. *(founder, 30 min + postcard/phone verify)*

### Quick site fixes (this chat — small, safe, no redesign work)

- [ ] **1.6 Add `/for-clippers` and `/for-brands` to `sitemap.xml`.**
  `src/routes/sitemap.js` omits both — the two pages "written to rank"
  are not submitted to anyone. ~5 lines.
- [ ] **1.7 Fix sitemap signal honesty** — real `<lastmod>` on `/`,
  drop `changefreq: daily` (the story page barely changes) → `monthly`.
- [ ] **1.8 Add a `WebSite` JSON-LD block** to the site head (enables the
  sitelinks treatment for the branded query).
- [ ] **1.9 Expand the `Organization` JSON-LD** (in `index.html` head):
  add `sameAs` (LinkedIn, Instagram, Discord, X, Crunchbase URLs once
  they exist — step 1.11), `foundingDate`, `founder`, `areaServed: "IN"`,
  `email` (needs `support@clipgrow.in` — see whats-next.md blocker).
- [ ] **1.10 Add "Guides" to the main site nav**
  (`premium-mock/src/components/Nav.tsx`). Right now `/guides` is
  footer-only, so the 9 articles are one crawl-hop from orphaned and get
  almost no internal link equity.

### Brand presence (founder — feeds AI engines especially)

- [ ] **1.11 Claim consistent profiles**, exact same name / tagline /
  URL everywhere: LinkedIn company page, Crunchbase, Instagram (bio +
  link), X/Twitter, a Product Hunt "coming soon", YourStory/Inc42 startup
  directories. AI engines lean heavily on cross-site consensus — the same
  facts stated in many places is what makes Grok/Perplexity confident
  enough to name you.
- [ ] **1.12 Create a Wikidata item** for ClipGrow (company, country India,
  inception, founders, official website). Low effort, and it's a
  structured fact source Google's knowledge graph and the LLMs read.
- [ ] **1.13 Submit to Brave Search** — Brave has no webmaster console;
  it just needs the site crawlable + in the sitemap + linked from other
  sites Brave already crawls (which steps 1.11 + Tier 3 links handle).

---

## TIER 2 — Core site changes (1–3 weeks, needs dev work, sets the ceiling)

### 2.1 Make the three marketing pages crawlable — ✅ DONE (2026-09-04), not yet deployed

**Shipped approach** (not full SSR — see below): the Worker post-processes the
SPA shell for `/`, `/for-clippers`, `/for-brands`. New files
`src/seo-content.js` (per-route copy + FAQ + JSON-LD) and
`src/routes/marketing.js` (HTMLRewriter: swaps `<title>`/description/canonical/
og+twitter per route, injects `WebSite`/`Service`/`FAQPage` JSON-LD into
`<head>`, injects a real `<div id="cg-seo">` block — `<h1>`, lede, sections,
FAQ `<dl>`, internal links — right before `<div id="root">`).
`premium-mock/src/main.tsx` removes `#cg-seo` on mount, so a JS visitor gets
the identical SPA. Worker falls back to the untouched shell on any error.
Guard test: `test/marketing-seo.test.mjs` (FAQ-drift vs `site.ts`, one-`<h1>`,
JSON-LD validity, title mirror vs `Seo.tsx`). Full suite 230/230.

Verified locally (`wrangler dev`): all 3 routes serve full HTML to `curl`
(8–12 KB vs the old 5 KB shell), per-route title/canonical correct, JSON-LD
parses, SPA still mounts and strips `#cg-seo`, client-nav + hard-reload work,
no console errors, pages render visually unchanged.

**Why not full SSR:** the design is built on scroll-reveal animations with
`visibility:hidden` defaults across ~12 components; server-rendering them and
making them correct at rest is a multi-day refactor with real regression risk
to the cinematic design. The injection approach delivers the same crawlability
for Bing/Brave/AI with a fraction of the surface area. Google (renders JS) is
handled by step 2.2 instead.

**To deploy:** `npm --prefix premium-mock run build:root -- --force` (already
run locally) then `npx wrangler deploy`. Rollback: `npx wrangler rollback`,
then `npm --prefix premium-mock run revert:apply`.

---

_Original plan for reference:_

**Problem:** `/`, `/for-clippers`, `/for-brands` serve a 5 KB empty React
shell. Googlebot renders JS eventually; **Bing, Brave, ChatGPT, Perplexity
and Grok largely do not.** Everything about ranking these pages is capped
here.

Steps:
- [ ] **2.1a** Add a **prerender step** to the `premium-mock` build:
  render each of `/`, `/for-clippers`, `/for-brands` to a full static
  HTML file (headings, hero copy, body text, FAQ markup all in the HTML)
  at build time; React hydrates on load for the animation. Emit
  `for-clippers.html` / `for-brands.html` / content-rich `index.html`.
  - Tooling: `vite-react-ssg`, `react-dom/server` + a small prerender
    script, or `@prerenderer/prerenderer`. Whichever fits the existing
    `rolldown` build with least friction.
- [ ] **2.1b** Wire `src/worker.js` to serve those files for the 3 paths,
  the same way it already serves `/campaigns/*` and `/guides/*`.
- [ ] **2.1c** Verify: `curl -A Googlebot https://clipgrow.in/for-clippers`
  returns the full copy, not a shell. Repeat for all 3.
- [ ] **2.1d** Re-test in the browser that hydration is seamless (no
  flash, animations still fire).

Fallback if prerender fights the build: server-render just the `<head>` +
a `<main>` prose block in the Worker for these 3 routes.

### 2.2 Fix on-page basics on the marketing pages

- [ ] **2.2a One real `<h1>` per route**, containing the target phrase.
  The scroll-headline animation currently leaves `<h1>` = `"is already
  here."`. Put the full phrase in the DOM (visually-hidden behind the
  animated spans is fine):
  - `/` → **ClipGrow — India's Performance Clipping Agency**
  - `/for-clippers` → **Get Paid to Clip Videos in India — ₹30–₹70 per 1,000 Views**
  - `/for-brands` → **Performance Video Distribution for Brands in India**
- [ ] **2.2b** Fix the duplicated `<h2>` render from the scroll animation
  (`"…actually delivered.\nactually delivered."`).
- [ ] **2.2c** Add **600–1,200 words** of real body copy per marketing
  page — target phrase in the first 100 words, sub-headed by the actual
  questions searchers ask, with real platform numbers and payout
  screenshots. This is the E-E-A-T evidence competitors can't fake.

### 2.3 Structured data (server-rendered, not client-injected)

- [ ] **2.3a** Move the **FAQ JSON-LD** out of `Seo.tsx`'s `useEffect`
  and bake it into the prerendered `/for-clippers` + `/for-brands` HTML
  (still built from the same array the visible accordion uses).
- [ ] **2.3b** Add **`Service` / `ProfessionalService`** schema on
  `/for-brands` (name, provider, areaServed IN, serviceType "video
  clipping / short-form distribution", offers).
- [ ] **2.3c** Add **`BreadcrumbList`** to guide pages (`src/routes/guides.js`
  — campaigns already have it).
- [ ] **2.3d** Validate every page in the **Rich Results Test** +
  **Schema.org validator**.

### 2.4 The exact-match pillar page

- [ ] **2.4** Decide: either promote `/for-brands` to explicitly own
  **"clipping agency in India"** (H1, title, URL, first paragraph, plus a
  dedicated section answering *"what is a clipping agency"* and *"what is
  clipping"*), or add a new `/clipping-agency-india` page. This page
  becomes the hub every relevant guide links up to, and it links down to
  each guide. One page, one head term, ruthlessly on-topic.

### 2.5 Internal linking pass

- [ ] **2.5a** Related-guides block at the foot of every guide (3–4 links).
- [ ] **2.5b** Every guide links to `/for-clippers` **or** `/for-brands`
  (currently they only link to `/#campaigns`).
- [ ] **2.5c** Each marketing page links into 2–3 specific guides in-body.
- [ ] **2.5d** The pillar page (2.4) ↔ every cluster guide, both directions.

### 2.6 Core Web Vitals

- [ ] **2.6a** Measure `/`, `/for-clippers`, a guide (PageSpeed Insights +
  the Search Console CWV report once data accrues).
- [ ] **2.6b** Likely fixes: the `BootScreen` delaying LCP, 3 font
  families (Anton + Inter 400–900 + Space Grotesk) — subset / drop
  weights / `font-display: optional`, defer GSAP off the two content
  pages (already partly done).
- [ ] **2.6c** Targets: LCP < 2.5s, INP < 200ms, CLS < 0.1 on mobile.

---

## TIER 3 — Content & authority (ongoing, months — this is where the head term is won)

### 3.1 Content engine — 2–4 pieces / month

Publish through the admin guides panel (no deploy). Each: one primary
keyword, title + H1 + URL + first-100-words aligned, 1,200–2,000 words,
real data, internal links in and out, a visible `dateModified`.

Priority order:
- [ ] **3.1a "What is clipping? (and how clippers get paid in India)"** —
  definitional, structured for the featured snippet **and** for AI
  answers ("Clipping is …"). Targets "what is clipping", "what is a
  clipping agency", "clipping meaning".
- [ ] **3.1b Pillar: "Clipping Agency in India"** (= step 2.4 if you made
  it a page; otherwise a deep guide).
- [ ] **3.1c "Clipper Jobs in India / Get Paid to Edit Reels"** — clipper
  acquisition head term.
- [ ] **3.1d "ClipConnect Alternative"** + **"Clipping Agencies in India,
  Compared"** — buyer-intent, names the rival, honest comparison table.
- [ ] **3.1e "Clipping Agency for Podcasts / YouTubers in India"** —
  brand-side long-tail with money intent.
- [ ] **3.1f** Refresh all 9 existing guides — current numbers, real
  screenshots, visible updated date.
- [ ] **3.1g** *Later, once the pillar ranks:* programmatic variants
  (niche / language / city — Malayalam creators, Bengaluru, gaming
  clippers…). See the `programmatic-seo` skill.

### 3.2 Link building (founder, ongoing — the actual bottleneck for the head term)

- [ ] **3.2a** Email every author of a currently-ranking "best clipping
  agencies" / "how to become a clipper" roundup — offer the India angle,
  ask to be included.
- [ ] **3.2b** Guest posts on Indian creator-economy / marketing blogs.
- [ ] **3.2c** Get mentioned in creator Discords / WhatsApp communities,
  Reddit (r/india, r/JuniorDoctorsIndia-style niche subs, r/NewTubers),
  Indie Hackers.
- [ ] **3.2d** Founder-story / "Kerala startup" PR pitch to YourStory,
  Inc42, The Hindu tech, local press.
- [ ] **3.2e** Partner pages: every brand that runs a campaign gets a
  case-study page they'll link to; clippers get a badge to embed.

### 3.3 Digital-PR linkbait

- [ ] **3.3** Publish **"The State of Clipping in India 2026"** — an
  original data report from aggregate platform numbers (CPMs by niche,
  average clipper earnings, view volumes, payout totals). One strong
  data asset earns more links + more AI citations than ten how-to posts,
  because everyone writing about the topic cites the numbers.

### 3.4 E-E-A-T

- [ ] **3.4a** Real author bios on guides (founder as a named `Person`
  with credentials / LinkedIn).
- [ ] **3.4b** An `/about` page: who runs ClipGrow, where, since when,
  how payouts are verified. Trust + entity signal.
- [ ] **3.4c** Collect and publish testimonials with `Review` schema;
  seed Google reviews on the Business Profile.

---

## TIER 4 — AI answer engines specifically (Perplexity, ChatGPT, Grok, Gemini)

Most of this is a by-product of Tiers 1–3, but do these deliberately.
Run the **`ai-seo`** skill when starting this tier.

- [ ] **4.1** Confirm the AI crawlers are allowed (step 1.4) and that
  `curl` as `GPTBot` / `PerplexityBot` / `OAI-SearchBot` gets full HTML
  (depends on 2.1).
- [ ] **4.2** Be in **Bing's** index and ranking (ChatGPT Search leans on
  Bing) — Tier 1.2 + Tier 2.
- [ ] **4.3** Write extractable answers: every guide opens with a 2–3
  sentence direct answer to its title question; use comparison **tables**,
  numbered steps, clear definitions. LLMs lift these verbatim.
- [ ] **4.4** Entity consistency everywhere (1.11 + 1.12) — same name,
  same one-line description, same founding facts. This is what moves an
  AI from "I'm not sure" to "ClipGrow is India's performance clipping
  agency…".
- [ ] **4.5** Get cited on the third-party pages AI engines already trust
  (3.2, 3.3). AI answers overwhelmingly cite sources that *other sources*
  cite.
- [ ] **4.6** Track it: monthly, ask each of ChatGPT / Perplexity / Grok /
  Gemini "what is the best clipping agency in India?" and "what is
  ClipGrow?" — log the answer + whether we're cited in the scoreboard.

---

## Audit findings (condensed reference)

| ID | Finding | Fixed by |
|---|---|---|
| C1 | `/`, `/for-clippers`, `/for-brands` are 100% client-rendered — invisible to Bing/Brave/most AI | 2.1 |
| C2 | Homepage `<h1>` is a broken animation fragment; `<h2>`s render duplicated | 2.2a/b |
| C3 | Homepage/story page targets no keyword, ~2.5k chars body | 2.2c, 2.4 |
| C4 | `/for-clippers` + `/for-brands` missing from sitemap | 1.6 |
| H1 | FAQ schema is client-injected only (fragile / unseen by non-Google) | 2.3a |
| H2 | Only 9 guides — thin topical cluster | 3.1 |
| H3 | Guides semi-orphaned (footer-only nav, no cross-links) | 1.10, 2.5 |
| H4 | No comparison / "alternative" pages | 3.1d |
| H5 | No crawlable exact-match "clipping agency in India" page | 2.4 |
| M1 | Core Web Vitals unmeasured; SPA + boot screen + 3 fonts = LCP risk | 2.6 |
| M2 | AI crawlers (GPTBot, Google-Extended…) blocked in robots.txt | 1.4 |
| M3 | Search Console + Bing Webmaster Tools not set up | 1.1, 1.2 |
| A1 | No Google Business Profile / LinkedIn / Crunchbase / Wikidata | 1.5, 1.11, 1.12 |
| A2 | Zero backlinks | 3.2, 3.3 |
| A3 | New domain, low authority — structural reason the head term is a long game | Tier 3 (time) |

### What's already good (don't rebuild)

Dynamic `sitemap.xml`; `robots.txt` with sitemap ref; 9 server-rendered
guides with unique title/meta + `Article` JSON-LD; server-rendered
campaign pages with `BreadcrumbList` + smart `noindex`; per-route head
management in `Seo.tsx`; solid homepage title + meta description; OG +
Twitter cards; HTTPS, `lang=en-IN`, mobile viewport; static
`Organization` JSON-LD.

---

## Target keyword map (first pass — refine after 1.3 baseline)

**Branded (win now):** clipgrow · clipgrow india · clipgrow login ·
clipgrow clipping · is clipgrow legit

**"What is" / informational (featured snippet + AI answers):**
what is clipping · what is a clipping agency · clipping meaning ·
what is clipping in india · how does clipping work

**Clipper-side (acquisition):** clipping agency in india · how to become a
clipper in india *(guide ✓)* · get paid to clip videos india · clipper
jobs india · earn money editing reels india · instagram reels clipping
*(guide ✓)* · how much do clippers earn per 1000 views india *(guide ✓)* ·
youtube shorts clipping · free video editing apps for clippers *(guide ✓)*

**Brand-side (revenue):** clipping agency india · clipping service india ·
performance influencer marketing india *(guide ✓)* · pay per view
influencer marketing · cpm vs flat fee influencer *(guide ✓)* · hire
clippers for brand campaign *(guide ✓)* · podcast clipping service india ·
repurpose long form content india · short form video distribution india ·
ugc agency india *(guide ✓ compare)*

**Comparison / consideration:** best clipping agencies in india *(guide ✓
— add "best" intent)* · clipconnect alternative · clipping agency vs ugc
agency *(guide ✓)* · how to choose a clipping agency *(guide ✓)*

---

## Metrics log

### 2026-09 — baseline
- GSC verified: **no** · Bing WMT: **no** · IndexNow: **no**
- "clipgrow": **#1 Google** (2026-09-04); Bing/Brave: not checked
- "clipping agency in india": not checked
- AI citation check: not run
- PageSpeed: not run
