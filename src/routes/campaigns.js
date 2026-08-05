import { matchPath } from '../http.js';
import { publicCampaign, campaignSpend } from '../db.js';

// Server-rendered public campaign pages, e.g. /campaigns/topperstreak-2.
//
// SEO: the homepage's campaign grid is populated entirely client-side after
// load (index.html, fetch('/api/public/campaigns')), so search engines never
// see a stable, individually-addressable URL per campaign -- everything they'd
// index is one generic homepage. This route gives each campaign a real HTML
// document with its data baked in server-side, so it can actually rank and be
// shared/linked on its own.
//
// Returns HTML (not JSON, unlike every other handler in src/routes/*.js), so
// it is deliberately its own file rather than folded into public.js, whose
// contract is "JSON only, public data only".

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN');
}

function notFoundPage() {
  return new Response(
    `<!DOCTYPE html><html lang="en-IN"><head><meta charset="UTF-8"><title>Campaign not found — ClipGrow</title>
<meta name="robots" content="noindex"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>body{background:#080D08;color:#C4D4C4;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;margin:0}
a{color:#3DFF7A}</style></head>
<body><div><h1 style="color:#F0F5F0">Campaign not found</h1><p>This campaign may have been renamed or removed.</p>
<p><a href="/">&larr; Back to ClipGrow</a></p></div></body></html>`,
    { status: 404, headers: { 'Content-Type': 'text/html; charset=UTF-8' } }
  );
}

function renderCampaignPage(c, origin) {
  const b = c.blueprint || {};
  const url = `${origin}/campaigns/${c.slug}`;
  const title = `${c.name} — Clipping Campaign | ClipGrow`;
  const description = (b.objective || c.description || `Earn ${money(c.cpm)} per 1,000 views clipping content for ${c.name} on ClipGrow, India's performance clipping agency.`).slice(0, 160);
  const pct = c.budget > 0 ? Math.min(100, Math.round((c.spent / c.budget) * 100)) : 0;

  // Campaigns not open to new clippers still get a real page (a shared link
  // shouldn't 404), but are told not to rank -- only 'active' represents
  // something worth surfacing in search results.
  const noindex = c.status !== 'active';

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'ClipGrow', item: origin + '/' },
      { '@type': 'ListItem', position: 2, name: 'Campaigns', item: origin + '/#campaigns' },
      { '@type': 'ListItem', position: 3, name: c.name, item: url }
    ]
  };

  return `<!DOCTYPE html>
<html lang="en-IN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${esc(url)}" />
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
${noindex ? '<meta name="robots" content="noindex, follow" />' : ''}
<meta property="og:type" content="website" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(url)}" />
<meta property="og:image" content="https://clipgrow.in/og-image.jpg" />
<meta property="og:site_name" content="ClipGrow" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(description)}" />
<meta name="twitter:image" content="https://clipgrow.in/og-image.jpg" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700;800&display=swap" rel="stylesheet" />
<script type="application/ld+json">${JSON.stringify(breadcrumbLd)}</script>
<style>
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
  :root{--bg:#080D08;--card:#0F170F;--card-h:#141E14;--border:#1A2C1A;--border-s:#223322;--neon:#3DFF7A;--white:#F0F5F0;--text:#C4D4C4;--muted:#566056;--muted-l:#849484}
  body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);line-height:1.65}
  h1,h2,h4{font-family:'Space Grotesk',sans-serif;color:var(--white)}
  a{color:var(--neon);text-decoration:none}
  .wrap{max-width:760px;margin:0 auto;padding:2.5rem 1.5rem 4rem}
  .back{font-size:.85rem;color:var(--muted-l);display:inline-block;margin-bottom:1.5rem}
  h1{font-size:clamp(1.6rem,4vw,2.2rem);margin-bottom:.5rem}
  .badge{display:inline-block;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.4px;padding:.25rem .6rem;border-radius:5px;background:rgba(61,255,122,.12);color:var(--neon);margin-bottom:1rem}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:1rem;margin:1.5rem 0}
  .stat{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1rem}
  .stat b{display:block;font-family:'Space Grotesk',sans-serif;font-size:1.3rem;color:var(--white)}
  .stat span{font-size:.72rem;color:var(--muted-l)}
  .bar{height:8px;border-radius:5px;background:var(--card-h);overflow:hidden;margin:1rem 0}
  .bar-fill{height:100%;background:var(--neon)}
  .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.5rem;margin:1.5rem 0}
  .card h2{font-size:1.1rem;margin-bottom:.6rem}
  .cta{display:inline-block;background:var(--neon);color:#060E06;font-weight:700;padding:.8rem 1.6rem;border-radius:8px;margin-top:1rem}
</style>
</head>
<body>
<div class="wrap">
  <a class="back" href="/">&larr; Back to ClipGrow</a>
  <span class="badge">${esc(c.status.replace('_', ' '))}</span>
  <h1>${esc(c.name)}</h1>
  <p>${esc(b.objective || c.description || '')}</p>

  <div class="stats">
    <div class="stat"><b>${esc(money(c.cpm))}</b><span>Per 1,000 views</span></div>
    <div class="stat"><b>${esc(money(c.budget))}</b><span>Total budget</span></div>
    <div class="stat"><b>${esc(money(c.remaining))}</b><span>Still available</span></div>
    ${c.min_views ? `<div class="stat"><b>${c.min_views.toLocaleString('en-IN')}</b><span>Min views to earn</span></div>` : ''}
  </div>
  <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>

  <div class="card">
    <h2>How this campaign works</h2>
    <p>Clippers post Reels featuring ${esc(c.name)} and earn ${esc(money(c.cpm))} per 1,000 verified views once their clip crosses ${c.min_views ? c.min_views.toLocaleString('en-IN') : '1,000'} views. Payouts follow ClipGrow's standard monthly cycle, no fee to join.</p>
    ${b.cta ? `<p style="margin-top:.6rem"><strong style="color:var(--white)">Call to action:</strong> ${esc(b.cta)}</p>` : ''}
    <a class="cta" href="/#campaigns">Join this campaign on ClipGrow</a>
  </div>
</div>
</body>
</html>`;
}

export async function handleCampaignPage(request, env, url) {
  if (request.method !== 'GET') return null;
  const params = matchPath('/campaigns/:slug', url.pathname);
  if (!params) return null;

  const row = await env.DB.prepare('SELECT * FROM campaigns WHERE slug = ?').bind(params.slug).first();
  if (!row) return notFoundPage();

  const spent = await campaignSpend(env.DB, row.id);
  const campaign = publicCampaign(row, spent);
  const html = renderCampaignPage(campaign, url.origin);

  const headers = { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'public, max-age=300' };
  if (campaign.status !== 'active') headers['X-Robots-Tag'] = 'noindex, follow';
  return new Response(html, { status: 200, headers });
}
