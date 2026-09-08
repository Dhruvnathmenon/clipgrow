import { handleAdmin } from './routes/admin.js';
import { handleClipper } from './routes/clipper.js';
import { handleModerator } from './routes/moderator.js';
import { handleClient } from './routes/client.js';
import { handleInstagramAuth } from './routes/instagram-auth.js';
import { handleYoutubeAuth } from './routes/youtube-auth.js';
import { handlePublic } from './routes/public.js';
import { handleMedia } from './routes/media.js';
import { handleCampaignPage } from './routes/campaigns.js';
import { handleSitemap } from './routes/sitemap.js';
import { handleGuide } from './routes/guides.js';
import { handleMarketing } from './routes/marketing.js';
import { reallocateAll } from './earnings.js';
import { createRefreshJob, advanceJob, reapStalledJobs, removeInactiveJoins } from './refresh-jobs.js';
import { getSession } from './auth.js';
import { err } from './http.js';

const handlers = [handleInstagramAuth, handleYoutubeAuth, handleAdmin, handleClipper, handleModerator, handleClient, handlePublic, handleMedia];

// One "Log In" link on the homepage points at /clipper -- both this and
// /client serve the same unified login page (login.html), which has a
// Clipper/Client toggle. The path you land on just decides which tab starts
// selected. admin.html and moderator.html both stay unlisted -- reached only
// by their raw filename, nothing links to them, and this file doesn't change
// that. Their security is API-level (requireAdmin / requireModerator), not
// page-level.
const LOGIN_PATH = '/clipper';
const CLIENT_LOGIN_PATH = '/client';

/** Client-router routes of the marketing SPA that have no file on disk. */
const SPA_ROUTES = new Set(['/for-clippers', '/for-brands']);

// Old paths kept as redirects so previously-shared links still land somewhere.
const LOGIN_ALIASES = new Set(['/login', '/login.html']);

// Pages the Worker refuses to serve without a session. Gating here means the
// HTML never reaches an anonymous visitor at all -- not even the empty shell.
const GATED = {
  '/dashboard': { asset: '/dashboard', role: 'clipper' },
  '/dashboard.html': { asset: '/dashboard', role: 'clipper' },
  '/tracker': { asset: '/tracker', role: 'any' },
  '/tracker.html': { asset: '/tracker', role: 'any' },
  '/client-dashboard': { asset: '/client-dashboard', role: 'client' },
  '/client-dashboard.html': { asset: '/client-dashboard', role: 'client' }
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

// ── Edge hardening ────────────────────────────────────────────────────────
//
// Applied to every response the Worker returns — static asset, API JSON,
// gated page, redirect. Absent entirely until a security pass flagged it:
// no HTTPS enforcement, no clickjacking protection, no MIME-sniff protection,
// no HSTS. None of it changes what any endpoint does; it only adds headers.

const STATIC_SECURITY_HEADERS = {
  // Stop the browser MIME-sniffing a response into something executable.
  'X-Content-Type-Options': 'nosniff',
  // Nothing here is ever meant to sit in a frame — not the marketing pages,
  // not the login form, not the dashboards. DENY, because there is no
  // same-origin framing either.
  'X-Frame-Options': 'DENY',
  // Full URL to our own origin; only the origin (no path) to third parties
  // like Discord, WhatsApp or an OAuth provider.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // We use none of these. Deny them site-wide so a future dependency can't
  // quietly start.
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  // 180 days. Once a browser has seen this it will not touch the domain over
  // plain HTTP at all — closing the window the 301 below still leaves on a
  // first-ever request.
  'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
};

// Content-Security-Policy. Two policies, because the site is two things.
//
// CSP_STRICT — the marketing SPA (/, /for-clippers, /for-brands, /new/*).
// A modern Vite build with zero inline script, so script-src can be locked to
// 'self'. Built from what the pages actually load, nothing speculative:
//   scripts  our own bundle only
//   styles   our own + the Google Fonts stylesheet + 'unsafe-inline' (the
//            hero and footer inject <style> blocks; components set style="")
//   fonts    our self-hosted .ttf + Google Fonts files
//   images   our own, data: URIs (the film-grain SVG), Unsplash placeholders
//   connect  same-origin only (/api/*)
const CSP_STRICT = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://images.unsplash.com",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

// CSP_APP — the hand-written pages (login, dashboards, admin, tracker, the
// server-rendered SEO pages). They rely on inline <script> blocks and inline
// onclick handlers, so a strict script-src would brick them. They still get
// the directives that matter for them and cannot break their own JS: no
// framing (the real threat to a login form), no plugins, no <base> hijack,
// no off-origin form posts. Tightening these to match the SPA is its own job
// (nonces + externalised handlers).
const CSP_APP = [
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const SPA_HTML_PATHS = new Set(['/', '/for-clippers', '/for-brands']);

function harden(res, url) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(STATIC_SECURITY_HEADERS)) h.set(k, v);

  if ((h.get('content-type') || '').includes('text/html')) {
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const strict = SPA_HTML_PATHS.has(p) || p === '/new' || p.startsWith('/new/');
    h.set('Content-Security-Policy', strict ? CSP_STRICT : CSP_APP);
  }

  // Content-hashed build assets never change under a given name (Vite bakes
  // the hash in), so the browser should keep them for a year instead of
  // sending a conditional request for every chunk on every navigation.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/new/assets/')) {
    h.set('Cache-Control', 'public, max-age=31536000, immutable');
  }

  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function route(request, env, url) {
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

  // The redesign, staged at /new alongside the live site.
  //
  // It is a single-page app: its client router owns /new/for-clippers and
  // /new/for-brands, which are NOT files on disk. Without this, a deep link,
  // a refresh, or a shared URL under /new hits the asset binding, finds
  // nothing, and 404s — the site would appear to work only if you never
  // reloaded. So real files are served as-is and everything else falls back
  // to the SPA shell.
  //
  // Scoped strictly to /new. The live site's routing is untouched: a typo
  // anywhere else still 404s the way it does today, which is why this is a
  // prefix check and not a global not_found_handling switch.
  //
  // X-Robots-Tag as well as the page's own noindex meta: the header also
  // covers anything under /new that is not HTML, and survives a build that
  // was made with the wrong base.
  if (path === '/new' || path.startsWith('/new/')) {
    const direct = await env.ASSETS.fetch(request);
    const res = direct.status === 404
      ? await env.ASSETS.fetch(new URL('/new/index.html', url.origin).toString())
      : direct;
    const out = new Response(res.body, res);
    out.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return out;
  }

  // The three client-rendered marketing routes: /, /for-clippers, /for-brands.
  //
  // /for-clippers and /for-brands belong to the client-side router; there is
  // no such file on disk. Reached by clicking a link they work, because the
  // router handles it in the page — but a hard refresh, a shared link, or a
  // crawler asks the server directly, and without this the asset binding
  // finds nothing and 404s.
  //
  // handleMarketing serves the SPA shell for all three, but first rewrites the
  // per-route <title>/description/canonical/og and injects a real, readable
  // HTML body (<h1>, copy, FAQ, internal links, JSON-LD). Without that a
  // crawler that does not execute JavaScript — Bingbot, Brave, and the
  // page-fetchers behind ChatGPT / Perplexity / Grok — indexes an empty
  // <div id="root">, and every shared link previews as the homepage. It falls
  // back to the untouched shell if anything goes wrong, so the worst case is
  // exactly today's behaviour.
  //
  // An explicit allowlist, not a catch-all. `not_found_handling: single-page-
  // application` would serve the marketing shell for every mistyped URL on
  // the domain — including /api typos and dashboard paths — and would tell
  // Google that infinitely many URLs are valid pages.
  if (path === '/' || SPA_ROUTES.has(path)) {
    try {
      const res = await handleMarketing(request, env, url);
      if (res) return res;
    } catch (e) {
      console.error(`marketing route error on ${path}:`, e.stack || e.message);
    }
    return env.ASSETS.fetch(new URL('/index.html', url.origin).toString());
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

  if (path === CLIENT_LOGIN_PATH || path === '/client.html') {
    const session = await getSession(request, env);
    if (session && session.role === 'client') return redirect('/client-dashboard');
    // Same unified login page as /clipper -- login.html reads the path to
    // decide which tab (Clipper/Client) starts selected.
    return servePrivate(env, url.origin, '/login');
  }

  const gate = GATED[path];
  if (gate) {
    const session = await getSession(request, env);
    const ok = session && (gate.role === 'any' ? true : session.role === gate.role);
    // Send an unauthenticated visitor to the login form that matches the
    // area they were trying to reach, not always the clipper one.
    if (!ok) return redirect(gate.role === 'client' ? CLIENT_LOGIN_PATH : LOGIN_PATH);
    return servePrivate(env, url.origin, gate.asset);
  }

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Force HTTPS. Cloudflare terminates TLS, but the :80 listener still
    // serves — so a network attacker on open Wi-Fi could hand a visitor a
    // modified page over plain HTTP. 301 (not 302) so it is remembered, and
    // HSTS makes it a one-time redirect per browser. Belt and braces with the
    // dashboard's "Always Use HTTPS" toggle.
    //
    // Skipped for localhost so `wrangler dev` and the Vite proxy (both HTTP)
    // keep working — production is the only place this matters.
    const localhost = url.hostname === 'localhost'
      || url.hostname === '127.0.0.1'
      || url.hostname.endsWith('.localhost');
    if (url.protocol === 'http:' && !localhost) {
      url.protocol = 'https:';
      return new Response(null, { status: 301, headers: { Location: url.toString() } });
    }

    return harden(await route(request, env, url), url);
  },

  // Continuation consumer for chained refresh jobs.
  //
  // Each message is one leg of a relay: run as much of the job as this fresh
  // invocation's external-subrequest budget allows, then advanceJob enqueues
  // the next leg if work remains. max_batch_size is 1, so a message is always
  // exactly one continuation.
  //
  // retry() rather than ack() on a thrown error is what makes Queues worth
  // using over synchronous self-chaining: a leg that dies is redelivered
  // automatically, and because the job's remaining work is persisted in
  // pending_json, the retry re-does nothing that already succeeded.
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      const jobId = message.body && message.body.jobId;
      if (!jobId) { message.ack(); continue; }
      try {
        const r = await advanceJob(env.DB, env, jobId, { onFinish: () => reallocateAll(env.DB) });
        if (r.error) console.error(`[refresh-queue] job ${jobId}: ${r.error}`);
        message.ack();
      } catch (e) {
        console.error(`[refresh-queue] job ${jobId} leg failed:`, e.stack || e.message);
        message.retry();
      }
    }
  },

  async scheduled(event, env, ctx) {
    // syncAllCampaigns's return value used to be silently discarded here --
    // its own error summary existed but nothing ever read it, so a sync
    // problem was invisible short of manually querying the database. Now it
    // is at minimum logged (visible via `wrangler tail` / the dashboard), and
    // the admin Overview separately surfaces any clip stuck failing across
    // several cron cycles, which is the signal that actually matters: a
    // single transient error here is normal and expected, a clip still
    // failing 12+ hours later is not.
    ctx.waitUntil((async () => {
      // Clear out any job that died mid-run BEFORE trying to create one. Its
      // row still counts as active for the unique index, so without this a
      // single lost invocation blocks every future sync permanently.
      try {
        const reaped = await reapStalledJobs(env.DB);
        if (reaped.length) console.log(`[cron sync] reaped abandoned job(s): ${reaped.join(', ')}`);
      } catch (e) {
        console.error('[cron sync] reaper failed', e && e.message);
      }

      // A joined-but-never-connected participation a week or older is
      // flagged inactive (not removed) -- see removeInactiveJoins's own
      // comment for why this is safe to run unattended every cron cycle.
      try {
        const flagged = await removeInactiveJoins(env.DB);
        if (flagged.length) console.log(`[cron sync] flagged inactive join(s): ${flagged.join(', ')}`);
      } catch (e) {
        console.error('[cron sync] inactive-join cleanup failed', e && e.message);
      }

      // respectCooldown TRUE, unlike a human-triggered refresh. Without it an
      // account with 60 clips would need 240 calls/hour from routine syncing
      // alone -- past Instagram's own 200/hour ceiling before anyone even
      // asks for a refresh. The cron is upkeep; humans get the full sweep.
      const created = await createRefreshJob(env.DB, {
        kind: 'global', triggeredBy: 'cron', respectCooldown: true
      });
      if (created.error) {
        // A global refresh is already in flight (admin-triggered, or a slow
        // previous cron). Skipping is correct -- it is already doing this work.
        console.log(`[cron sync] skipped: ${created.error}`);
        return;
      }
      const r = await advanceJob(env.DB, env, created.job_id, { onFinish: () => reallocateAll(env.DB) });
      console.log(`[cron sync] job ${created.job_id}: ${created.total_items} items, first chunk spent ${r.calls} calls, ${r.remaining} remaining`);
    })());
  }
};
