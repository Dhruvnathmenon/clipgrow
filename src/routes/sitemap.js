// Dynamic sitemap.xml, generated fresh from D1 on every request (cached at the
// edge for an hour — see Cache-Control below). Not a static file: campaigns
// and guides come and go, so a hand-maintained sitemap would drift out of
// date immediately. This is the single source of truth for "what exists".

function urlEntry(loc, { lastmod, changefreq } = {}) {
  return `  <url>\n    <loc>${loc}</loc>\n${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ''}${changefreq ? `    <changefreq>${changefreq}</changefreq>\n` : ''}  </url>`;
}

function isoDate(ms) {
  return ms ? new Date(ms).toISOString().slice(0, 10) : undefined;
}

export async function handleSitemap(request, env, url) {
  if (request.method !== 'GET' || url.pathname !== '/sitemap.xml') return null;

  const origin = url.origin;
  const entries = [
    urlEntry(`${origin}/`, { changefreq: 'daily' }),
    // Legal pages are listed so Meta and Google reviewers -- and crawlers --
    // can always find them from a single canonical place.
    urlEntry(`${origin}/privacy`, { changefreq: 'yearly' }),
    urlEntry(`${origin}/terms`, { changefreq: 'yearly' }),
    urlEntry(`${origin}/data-deletion`, { changefreq: 'yearly' })
  ];

  const { results: campaigns } = await env.DB.prepare(
    "SELECT slug, created_at FROM campaigns WHERE slug IS NOT NULL AND status IN ('active', 'budget_full', 'completed') ORDER BY created_at DESC"
  ).all();
  for (const c of campaigns || []) {
    entries.push(urlEntry(`${origin}/campaigns/${c.slug}`, { lastmod: isoDate(c.created_at), changefreq: 'weekly' }));
  }

  const { results: guides } = await env.DB.prepare(
    "SELECT slug, updated_at, created_at FROM guides WHERE status = 'published' ORDER BY created_at DESC"
  ).all().catch(() => ({ results: [] })); // table may not exist yet on first deploy before migration runs
  entries.push(urlEntry(`${origin}/guides`, { changefreq: 'weekly' }));
  for (const g of guides || []) {
    entries.push(urlEntry(`${origin}/guides/${g.slug}`, { lastmod: isoDate(g.updated_at || g.created_at), changefreq: 'monthly' }));
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>`;

  return new Response(xml, {
    status: 200,
    headers: { 'Content-Type': 'application/xml; charset=UTF-8', 'Cache-Control': 'public, max-age=3600' }
  });
}
