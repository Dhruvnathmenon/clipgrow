import { handleAdmin } from './routes/admin.js';
import { handleClipper } from './routes/clipper.js';
import { handleInstagramAuth } from './routes/instagram-auth.js';
import { handlePublic } from './routes/public.js';
import { handleMedia } from './routes/media.js';
import { handleCampaignPage } from './routes/campaigns.js';
import { handleSitemap } from './routes/sitemap.js';
import { handleGuide } from './routes/guides.js';
import { syncAllCampaigns } from './earnings.js';
import { getSession } from './auth.js';
import { err } from './http.js';

const handlers = [handleInstagramAuth, handleAdmin, handleClipper, handlePublic, handleMedia];

// The clipper area is unlisted: it lives at /clipper and nothing on the public
// site links to it.
const LOGIN_PATH = '/clipper';

// Old paths kept as redirects so previously-shared links still land somewhere.
const LOGIN_ALIASES = new Set(['/login', '/login.html']);

// Pages the Worker refuses to serve without a session. Gating here means the
// HTML never reaches an anonymous visitor at all -- not even the empty shell.
const GATED = {
  '/dashboard': { asset: '/dashboard', role: 'clipper' },
  '/dashboard.html': { asset: '/dashboard', role: 'clipper' },
  '/tracker': { asset: '/tracker', role: 'any' },
  '/tracker.html': { asset: '/tracker', role: 'any' }
};

function redirect(to) {
  return new Response(null, { status: 302, headers: { Location: to, 'Cache-Control': 'no-store' } });
}

/** Fetches a static asset by path and marks it uncacheable. */
async function servePrivate(env, origin, assetPath) {
  const res = await env.ASSETS.fetch(new URL(assetPath, origin).toString());
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'no-store, private');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

    if (path.startsWith('/api/')) {
      for (const handler of handlers) {
        try {
          const res = await handler(request, env, url);
          if (res) return res;
        } catch (e) {
          console.error(`handler error on ${path}:`, e.stack || e.message);
          return err('Internal server error', 500);
        }
      }
      return err('Not found', 404);
    }

    // SEO surfaces: server-rendered so they're crawlable/shareable on their
    // own, unlike the homepage's client-fetched campaign tiles. All public,
    // no gating, all generated fresh from D1 -- never a static file.
    if (path === '/sitemap.xml' || path.startsWith('/campaigns/') || path === '/guides' || path.startsWith('/guides/')) {
      try {
        const res = path === '/sitemap.xml' ? await handleSitemap(request, env, url)
          : path.startsWith('/campaigns/') ? await handleCampaignPage(request, env, url)
          : await handleGuide(request, env, url);
        if (res) return res;
      } catch (e) {
        console.error(`SEO route error on ${path}:`, e.stack || e.message);
        return err('Internal server error', 500);
      }
    }

    if (LOGIN_ALIASES.has(path)) return redirect(LOGIN_PATH);

    if (path === LOGIN_PATH) {
      // Already signed in? Skip the form.
      const session = await getSession(request, env);
      if (session && session.role === 'clipper') return redirect('/dashboard');
      return servePrivate(env, url.origin, '/login');
    }

    const gate = GATED[path];
    if (gate) {
      const session = await getSession(request, env);
      const ok = session && (gate.role === 'any' ? true : session.role === gate.role);
      if (!ok) return redirect(LOGIN_PATH);
      return servePrivate(env, url.origin, gate.asset);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncAllCampaigns(env.DB));
  }
};
