// Crawlable HTML for the three client-rendered marketing routes.
//
// WHY THIS FILE EXISTS. `/`, `/for-clippers` and `/for-brands` are a React SPA
// (premium-mock/, built to the repo root). The HTML the server sends for all
// three is a ~5 KB shell — <div id="root"></div> and a script tag. A browser
// runs the script and builds the page; a crawler that does not run JavaScript
// (Bingbot, Brave, and every AI answer engine's fetcher — ChatGPT, Perplexity,
// Grok) sees an empty page.
//
// src/routes/marketing.js takes the shell and, for these three paths, swaps in
// per-route <title>/description/canonical and injects the block below as
// `<div id="cg-seo">` just before `<div id="root">`. React's entry point
// (premium-mock/src/main.tsx) removes #cg-seo on mount, so a JS visitor sees
// the real app exactly as before — the block is only ever the crawler's copy
// and a brief first-paint for slow connections.
//
// The copy here is deliberately its own thing, not pulled from the SPA's
// animated components: it is written to be read flat, keyword-first, by a
// machine. The FAQ text DOES mirror premium-mock/src/data/site.ts word for
// word — FAQPage schema whose answers do not match the answers a visitor can
// read is the mismatch Google penalises, so test/marketing-seo.test.mjs
// asserts they stay identical.

const SITE = 'https://clipgrow.in';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---------------------------------------------------------------------------
// FAQ arrays — kept identical to premium-mock/src/data/site.ts (CLIPPER_FAQ,
// BRAND_FAQ). If you edit the copy in one place, edit it in the other; the
// test will fail until they match.
// ---------------------------------------------------------------------------

const CLIPPER_FAQ = [
  {
    q: 'Do I need followers or an existing account?',
    a: "No. You can start on a brand new account with zero followers. Short-form feeds push clips to people who don't follow you, so what decides your earnings is the edit and the hook — not your audience size. Every clip is paid on verified views, whoever's account it went out from.",
  },
  {
    q: 'What do I need to get started?',
    a: 'A smartphone is all you need — any free video editing app, an Instagram or YouTube account, and stable internet for uploads. We provide all brand source videos, style guides, caption templates and posting instructions inside the community.',
  },
  {
    q: 'When exactly do I get paid?',
    a: 'Payouts run every Sunday over UPI. Minimum payout is ₹500 per run — anything below that rolls over to the next Sunday. Supported: GPay, PhonePe, Paytm.',
  },
  {
    q: 'Is there any fee to join?',
    a: 'None. ClipGrow is completely free. No fee to access campaigns, receive payouts or participate. Zero investment — ever. You clip, we verify, you get paid.',
  },
  {
    q: 'What if a clip goes viral — millions of views?',
    a: "There's no cap on views — we keep counting however far a clip travels. 10L views at ₹50 CPM = ₹50,000 in a month. Each campaign does set a maximum payout per clip, shown before you join, so check that ceiling when you pick one.",
  },
  {
    q: 'What resources does ClipGrow provide?',
    a: 'Brand source videos to clip from, a style guide and tone of voice, caption and CTA templates, a posting schedule with platform guidelines, and a community of clippers to learn from. You bring the edit — everything else is handed to you.',
  },
];

const BRAND_FAQ = [
  {
    q: 'How does the payment model work exactly?',
    a: "You set a campaign budget. 100% of it forms the clipper pool, paid at the CPM you set — we take nothing from it. Our 20% management fee sits on top, so your total commitment is 120% of the budget. You pay 40% of that upfront and the remaining 60% as the first tranche runs down. Stop any time on five days' notice — clippers with videos already scheduled are compensated, and everything unspent is refunded. No lock-in.",
  },
  {
    q: 'Can I stop a campaign, and what happens to my money?',
    a: "Yes, any time — we ask for five days' notice so we can tell clippers to stop, and any clips already scheduled in that window are compensated. We keep only what was spent on views delivered, plus our 20% fee on that portion; everything unspent is refunded. On a ₹1,00,000 budget you pay ₹48,000 upfront. Stop at 30% utilisation and ₹36,000 is consumed — ₹12,000 is returned.",
  },
  {
    q: 'How do you verify brand guidelines?',
    a: 'Every clip is manually reviewed before it counts toward payout or reporting. We check CTA accuracy, brand tone, visual style, no false claims, no off-brand content. Clips that fail are disqualified — the clipper is not paid and the content is flagged.',
  },
  {
    q: 'What is the minimum budget to run a campaign?',
    a: 'Contact us to discuss — we tailor campaigns based on your product price, target audience and objectives, and recommend a budget that makes mathematical sense for your ROI before you commit.',
  },
  {
    q: 'How do you track sales and traffic?',
    a: "You provide a unique tracked link (UTM-tagged or your own tool). Every sale or click through that link is attributed to the campaign. We don't touch your backend — you have full visibility at all times.",
  },
  {
    q: 'What types of products work best?',
    a: 'Short-form video works best for digital products (courses, SaaS, subscriptions), e-commerce with a clear value proposition, service businesses and personal brands — especially anything solving a real problem for 14–35 year old Indians.',
  },
];

// ---------------------------------------------------------------------------
// Per-route config. `title` / `description` mirror premium-mock's Seo.tsx so
// the server <head> and the client's head-management agree.
// ---------------------------------------------------------------------------

export const SEO_ROUTES = {
  '/': {
    path: '/',
    title: 'ClipGrow — Clipping Agency in India | Get Paid Per 1,000 Views',
    description:
      "ClipGrow is India's performance clipping agency. Clippers earn ₹30–₹70 per 1,000 verified views with zero followers required. Brands pay only for results — no flat fees, no lock-in. Started in Kerala, now pan-India.",
    h1: "ClipGrow — India's Performance Clipping Agency",
    lede:
      'ClipGrow is a performance-based clipping agency in India. Brands fund campaigns; creators — "clippers" — cut that footage into short-form videos (Instagram Reels and YouTube Shorts) and get paid ₹30–₹70 for every 1,000 verified views. Started in Kerala, now working with clippers across India.',
    sections: [
      {
        h2: 'What is a clipping agency?',
        body:
          'A clipping agency sits between brands that have long-form video — podcasts, interviews, webinars, course material — and a network of video editors who cut that footage into short vertical clips and post them to their own social accounts. The brand pays only for the views those clips deliver. The editors are paid per 1,000 views. ClipGrow runs this model in India: we manage the campaigns, verify every clip against the brand brief, and settle payouts every Sunday over UPI.',
      },
      {
        h2: 'For clippers: get paid per 1,000 views',
        body:
          'No followers, no investment, no experience required. Pick a campaign, cut the footage we provide into a 30–60 second clip, post it, and earn ₹30–₹70 per 1,000 verified views — paid every Sunday over UPI once your balance clears ₹500.',
        link: { href: '/for-clippers', text: 'How clipping pays in India →' },
      },
      {
        h2: 'For brands: pay only for views delivered',
        body:
          'Your long-form footage cut into Reels and Shorts by dozens of creators across India. You set the CPM, pay 40% upfront, and are only ever charged for views that actually landed. Stop any time on five days’ notice with the rest refunded.',
        link: { href: '/for-brands', text: 'Run a campaign with ClipGrow →' },
      },
      {
        h2: 'Guides',
        body:
          'In-depth guides on becoming a clipper in India, how much clippers earn per 1,000 views, choosing a clipping agency, and running performance-based influencer campaigns.',
        link: { href: '/guides', text: 'Read the ClipGrow guides →' },
      },
    ],
    links: [
      { href: '/for-clippers', text: 'For clippers' },
      { href: '/for-brands', text: 'For brands' },
      { href: '/guides', text: 'Guides' },
      { href: '/privacy', text: 'Privacy' },
      { href: '/terms', text: 'Terms' },
    ],
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: 'ClipGrow',
        url: SITE + '/',
        description: "India's performance clipping agency.",
      },
    ],
  },

  '/for-clippers': {
    path: '/for-clippers',
    title: 'Get Paid to Clip — ₹30–₹70 per 1,000 Views | ClipGrow',
    description:
      'Earn ₹30–₹70 per 1,000 verified views editing short-form clips. No followers needed, no investment, all footage provided. Paid every Sunday over UPI once you clear ₹500.',
    h1: 'Get Paid to Clip Videos in India',
    lede:
      'Clip the footage ClipGrow gives you, post it to Instagram Reels or YouTube Shorts, and take ₹30–₹70 for every 1,000 verified views — paid every Sunday over UPI. No followers needed. No investment. Anyone with a phone can start.',
    sections: [
      {
        h2: 'How it works',
        list: [
          'Join the community on Discord — campaigns drop every week with source videos, the CPM, style guides and posting instructions.',
          'Pick a campaign. Every live campaign shows its CPM and its maximum payout per clip before you commit a minute.',
          'Cut the best 30–60 seconds out of the source video, add your hook and captions with any free phone editor, and post from your own account.',
          'Submit the link. We track views directly from the platform and check the clip against the brief. Verified views convert to rupees and land in your UPI every Sunday — minimum ₹500 per run.',
        ],
      },
      {
        h2: 'What you need',
        body:
          'A smartphone, any free video editing app, an Instagram or YouTube account, and stable internet. ClipGrow provides the brand source videos, style guides, caption templates and posting instructions.',
      },
    ],
    faq: CLIPPER_FAQ,
    links: [
      { href: '/for-brands', text: "I'm a brand instead" },
      { href: '/guides/how-to-become-a-clipper-in-india', text: 'How to become a clipper in India' },
      { href: '/guides/how-much-do-clippers-earn-per-1000-views', text: 'How much clippers earn per 1,000 views' },
      { href: '/guides', text: 'All guides' },
    ],
  },

  '/for-brands': {
    path: '/for-brands',
    title: 'Performance Video Distribution for Brands | ClipGrow',
    description:
      "Your footage cut into Reels and Shorts by dozens of creators. Pay only for views actually delivered — you set the CPM, 40% upfront, stop any time on five days' notice with the rest refunded.",
    h1: 'Performance Video Distribution for Brands in India',
    lede:
      'ClipGrow turns your long-form footage into hundreds of Reels and Shorts, cut and posted by real creators across India. You pay only for views that actually landed — you set the CPM, 40% upfront, and stop any time on five days’ notice with everything unspent refunded.',
    sections: [
      {
        h2: 'The offer',
        list: [
          'Pay only for delivery. Your budget converts into views that actually happened. Stop on five days’ notice and whatever is unspent is refunded.',
          'We handle everything — brief, creator recruitment, content review, distribution, compliance. You share your product; ClipGrow does the rest.',
          'Brand safety. Every clip is reviewed before it counts — CTA accuracy, guideline compliance, and that your brand is portrayed positively. Violations disqualify clippers permanently.',
        ],
      },
      {
        h2: 'What you commit',
        body:
          '120% of the campaign budget. The full 100% becomes the clipper pool and is paid at the CPM you set — ClipGrow takes nothing from it. The separate 20% management fee is the only money ClipGrow earns. 40% is due upfront; the remaining 60% falls due only once that first tranche is close to used up.',
      },
    ],
    faq: BRAND_FAQ,
    links: [
      { href: '/for-clippers', text: "I'd rather clip" },
      { href: '/guides/how-to-hire-ugc-clippers-for-brand-campaign', text: 'How to hire UGC clippers for a brand campaign' },
      { href: '/guides/performance-based-influencer-marketing-india', text: 'Performance-based influencer marketing in India' },
      { href: '/guides', text: 'All guides' },
    ],
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'Service',
        serviceType: 'Short-form video clipping and distribution',
        provider: { '@type': 'Organization', name: 'ClipGrow', url: SITE + '/' },
        areaServed: { '@type': 'Country', name: 'India' },
        description:
          'Performance-based short-form video distribution: a brand’s long-form footage cut into Reels and Shorts by a network of creators, priced per 1,000 verified views.',
      },
    ],
  },
};

function faqJsonLd(faq) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map(item => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };
}

/** Every JSON-LD object for a route, as one string of <script> tags. */
export function renderJsonLd(cfg) {
  const blocks = [...(cfg.jsonLd || [])];
  if (cfg.faq && cfg.faq.length) blocks.push(faqJsonLd(cfg.faq));
  return blocks
    .map(b => `<script type="application/ld+json">${JSON.stringify(b)}</script>`)
    .join('');
}

const BLOCK_STYLE =
  '#cg-seo{position:absolute;left:0;top:0;width:100%;z-index:0;background:#080D08;color:#C4D4C4;' +
  'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.6}' +
  '#cg-seo .cg-seo-wrap{max-width:720px;margin:0 auto;padding:5rem 1.5rem 3rem}' +
  '#cg-seo h1{font-size:1.9rem;color:#F0F5F0;margin:0 0 1rem}' +
  '#cg-seo h2{font-size:1.2rem;color:#F0F5F0;margin:2rem 0 .5rem}' +
  '#cg-seo p{margin:0 0 1rem}#cg-seo ul{margin:0 0 1rem 1.2rem}#cg-seo li{margin:0 0 .4rem}' +
  '#cg-seo a{color:#3DFF7A}#cg-seo dt{color:#F0F5F0;font-weight:600;margin-top:1rem}#cg-seo dd{margin:.3rem 0 0}';

/**
 * The crawlable body block. Rendered into `<div id="cg-seo">` before the SPA
 * root; premium-mock/src/main.tsx removes it once React mounts.
 */
export function renderSeoBlock(cfg) {
  const sections = (cfg.sections || []).map(s => {
    const parts = [`<h2>${esc(s.h2)}</h2>`];
    if (s.body) parts.push(`<p>${esc(s.body)}</p>`);
    if (s.list) parts.push(`<ul>${s.list.map(li => `<li>${esc(li)}</li>`).join('')}</ul>`);
    if (s.link) parts.push(`<p><a href="${esc(s.link.href)}">${esc(s.link.text)}</a></p>`);
    return parts.join('');
  }).join('');

  const faq = cfg.faq && cfg.faq.length
    ? `<h2>Frequently asked questions</h2><dl>${cfg.faq
        .map(f => `<dt>${esc(f.q)}</dt><dd>${esc(f.a)}</dd>`)
        .join('')}</dl>`
    : '';

  const links = (cfg.links || []).length
    ? `<h2>More from ClipGrow</h2><ul>${cfg.links
        .map(l => `<li><a href="${esc(l.href)}">${esc(l.text)}</a></li>`)
        .join('')}</ul>`
    : '';

  return (
    `<style>${BLOCK_STYLE}</style>` +
    `<div class="cg-seo-wrap">` +
    `<h1>${esc(cfg.h1)}</h1>` +
    `<p>${esc(cfg.lede)}</p>` +
    sections +
    faq +
    links +
    `</div>`
  );
}
