import { SEO_ROUTES, renderSeoBlock, renderJsonLd } from '../seo-content.js';

// Server-side SEO for the three client-rendered marketing routes: /,
// /for-clippers, /for-brands.
//
// These are a React SPA (premium-mock/, built to the repo root). The HTML the
// Worker serves for every one of them is the same ~5 KB shell — an empty
// <div id="root"> plus a script tag. A JS-capable browser fills it in; a
// crawler that does not run JavaScript (Bingbot, Brave, and the page-fetchers
// behind ChatGPT / Perplexity / Grok) sees nothing.
//
// This handler takes that shell and, per route:
//   1. rewrites <title>, <meta name=description>, canonical and the og/twitter
//      title+description+url so a shared link and a non-Google index show the
//      right page rather than the homepage on all three;
//   2. injects per-route JSON-LD (WebSite / Service / FAQPage) into <head>;
//   3. injects a real, readable HTML block (<h1>, copy, FAQ, internal links)
//      as `<div id="cg-seo">` immediately before `<div id="root">`.
//
// premium-mock/src/main.tsx removes #cg-seo the moment React mounts, so a
// normal visitor gets the exact SPA they get today — the block is the
// crawler's copy and a brief first paint on a slow connection. See
// src/seo-content.js for the copy and the reasoning.
//
// HTMLRewriter rather than string replacement: the built index.html wraps its
// meta tags across several lines, which a regex handles badly and an HTML
// parser handles for free.

const CANONICAL_ORIGIN = 'https://clipgrow.in';

export async function handleMarketing(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;

  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const cfg = SEO_ROUTES[path];
  if (!cfg) return null;

  // The SPA shell is the same file for every route.
  const shell = await env.ASSETS.fetch(new URL('/index.html', url.origin).toString());
  if (!shell.ok) return null;
  const contentType = shell.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return null;

  const canonical = path === '/' ? `${CANONICAL_ORIGIN}/` : `${CANONICAL_ORIGIN}${path}`;
  const headExtras = renderJsonLd(cfg);
  const seoBlock = renderSeoBlock(cfg);

  const setContent = attr => ({ element(el) { el.setAttribute(attr, cfg.description); } });
  const setTitleAttr = attr => ({ element(el) { el.setAttribute(attr, cfg.title); } });

  const rewriter = new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(cfg.title); } })
    .on('meta[name="description"]', setContent('content'))
    .on('meta[property="og:description"]', setContent('content'))
    .on('meta[name="twitter:description"]', setContent('content'))
    .on('meta[property="og:title"]', setTitleAttr('content'))
    .on('meta[name="twitter:title"]', setTitleAttr('content'))
    .on('meta[property="og:url"]', { element(el) { el.setAttribute('content', canonical); } })
    .on('link[rel="canonical"]', { element(el) { el.setAttribute('href', canonical); } })
    .on('head', { element(el) { if (headExtras) el.append(headExtras, { html: true }); } })
    .on('div#root', {
      element(el) { el.before(`<div id="cg-seo">${seoBlock}</div>`, { html: true }); },
    });

  const transformed = rewriter.transform(shell);
  const headers = new Headers(transformed.headers);
  headers.set('Content-Type', 'text/html; charset=UTF-8');
  headers.set('Cache-Control', 'public, max-age=300');
  return new Response(transformed.body, { status: 200, headers });
}
