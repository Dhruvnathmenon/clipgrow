import { matchPath } from '../http.js';

// Content/guide pages: /guides (hub) and /guides/:slug (article), both
// rendered server-side from the D1 `guides` table (migration 010) on every
// request. Nothing here is a static file -- content lives in the database and
// is managed through the admin panel, so publishing or editing an article
// never requires a code deploy.

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const HEAD_STYLE = `
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
  :root{--bg:#080D08;--card:#0F170F;--border:#1A2C1A;--neon:#3DFF7A;--white:#F0F5F0;--text:#C4D4C4;--muted-l:#849484}
  body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);line-height:1.7}
  h1,h2,h3{font-family:'Space Grotesk',sans-serif;color:var(--white);line-height:1.25}
  a{color:var(--neon)}
  .wrap{max-width:720px;margin:0 auto;padding:2.5rem 1.5rem 4rem}
  .back{font-size:.85rem;color:var(--muted-l);display:inline-block;margin-bottom:1.5rem;text-decoration:none}
  h1{font-size:clamp(1.6rem,4vw,2.1rem);margin-bottom:1rem}
  .badge{display:inline-block;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.4px;padding:.25rem .6rem;border-radius:5px;background:rgba(61,255,122,.12);color:var(--neon);margin-bottom:1rem}
  .body h2{font-size:1.25rem;margin:1.8rem 0 .7rem}
  .body h3{font-size:1.05rem;margin:1.4rem 0 .5rem}
  .body p{margin-bottom:1rem}
  .body ul,.body ol{margin:0 0 1rem 1.3rem}
  .body li{margin-bottom:.4rem}
  .body strong{color:var(--white)}
  .cta{display:inline-block;background:var(--neon);color:#060E06;font-weight:700;padding:.8rem 1.6rem;border-radius:8px;margin-top:1.5rem;text-decoration:none}
  .list-item{display:block;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1.1rem 1.3rem;margin-bottom:.9rem;text-decoration:none}
  .list-item h3{font-size:1.02rem;margin-bottom:.3rem}
  .list-item p{color:var(--muted-l);font-size:.85rem;margin:0}
`;

const FONT_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com" /><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700;800&display=swap" rel="stylesheet" />`;

function page(title, description, canonical, bodyHtml, extraHead = '') {
  return `<!DOCTYPE html>
<html lang="en-IN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${esc(canonical)}" />
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(canonical)}" />
<meta property="og:image" content="https://clipgrow.in/og-image.jpg" />
<meta property="og:site_name" content="ClipGrow" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(description)}" />
<meta name="twitter:image" content="https://clipgrow.in/og-image.jpg" />
${FONT_LINK}
${extraHead}
<style>${HEAD_STYLE}</style>
</head>
<body><div class="wrap">${bodyHtml}</div></body>
</html>`;
}

async function renderHub(env, origin) {
  const { results } = await env.DB.prepare(
    "SELECT slug, title, meta_description, audience FROM guides WHERE status = 'published' ORDER BY created_at DESC"
  ).all();

  const items = (results || []).map(g => `
    <a class="list-item" href="/guides/${esc(g.slug)}">
      <h3>${esc(g.title)}</h3>
      <p>${esc(g.meta_description || '')}</p>
    </a>`).join('');

  const body = `
    <a class="back" href="/">&larr; Back to ClipGrow</a>
    <h1>Guides for Clippers &amp; Brands</h1>
    <p style="color:var(--muted-l);margin-bottom:1.8rem">Everything about clipping, earning per view, and running performance campaigns in India.</p>
    ${items || '<p style="color:var(--muted-l)">More guides coming soon.</p>'}`;

  return page(
    'Guides — ClipGrow | Clipping & Performance Marketing in India',
    'Guides on becoming a clipper, earning per view, and running performance-based influencer campaigns in India.',
    `${origin}/guides`,
    body
  );
}

async function renderArticle(env, origin, slug) {
  const g = await env.DB.prepare("SELECT * FROM guides WHERE slug = ? AND status = 'published'").bind(slug).first();
  if (!g) return null;

  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: g.title,
    description: g.meta_description || '',
    author: { '@type': 'Organization', name: 'ClipGrow' },
    publisher: { '@type': 'Organization', name: 'ClipGrow' },
    datePublished: new Date(g.created_at).toISOString(),
    dateModified: new Date(g.updated_at || g.created_at).toISOString()
  };

  const body = `
    <a class="back" href="/guides">&larr; All guides</a>
    <span class="badge">${g.audience === 'brand' ? 'For Brands' : 'For Clippers'}</span>
    <h1>${esc(g.title)}</h1>
    <div class="body">${g.body_html}</div>
    <a class="cta" href="/#campaigns">${g.audience === 'brand' ? 'Start a campaign on ClipGrow' : 'Join ClipGrow as a clipper'}</a>`;

  return page(
    `${g.title} | ClipGrow`,
    g.meta_description || g.title,
    `${origin}/guides/${g.slug}`,
    body,
    `<script type="application/ld+json">${JSON.stringify(articleLd)}</script>`
  );
}

export async function handleGuide(request, env, url) {
  if (request.method !== 'GET') return null;

  if (url.pathname === '/guides') {
    const html = await renderHub(env, url.origin);
    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'public, max-age=300' } });
  }

  const params = matchPath('/guides/:slug', url.pathname);
  if (!params) return null;

  const html = await renderArticle(env, url.origin, params.slug);
  if (!html) {
    return new Response(
      `<!DOCTYPE html><html lang="en-IN"><head><meta charset="UTF-8"><title>Guide not found — ClipGrow</title><meta name="robots" content="noindex"></head>
       <body style="background:#080D08;color:#C4D4C4;font-family:sans-serif;text-align:center;padding:4rem 1rem"><h1 style="color:#fff">Guide not found</h1><p><a href="/guides" style="color:#3DFF7A">Browse all guides</a></p></body></html>`,
      { status: 404, headers: { 'Content-Type': 'text/html; charset=UTF-8' } }
    );
  }
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'public, max-age=300' } });
}
