import { handleAdmin } from './routes/admin.js';
import { handleClipper } from './routes/clipper.js';
import { handleClient } from './routes/client.js';
import { handleInstagramAuth } from './routes/instagram-auth.js';
import { handleYoutubeAuth } from './routes/youtube-auth.js';
import { handlePublic } from './routes/public.js';
import { handleMedia } from './routes/media.js';
import { handleCampaignPage } from './routes/campaigns.js';
import { handleSitemap } from './routes/sitemap.js';
import { handleGuide } from './routes/guides.js';
import { reallocateAll } from './earnings.js';
import { createRefreshJob, advanceJob, reapStalledJobs } from './refresh-jobs.js';
import { getSession } from './auth.js';
import { err } from './http.js';

const handlers = [handleInstagramAuth, handleYoutubeAuth, handleAdmin, handleClipper, handleClient, handlePublic, handleMedia];

// One "Log In" link on the homepage points at /clipper -- both this and
// /client serve the same unified login page (login.html), which has a
// Clipper/Client toggle. The path you land on just decides which tab starts
// selected. admin.html stays unlisted -- reached only by its raw filename,
// nothing links to it, and this file doesn't change that.
const LOGIN_PATH = '/clipper';
const CLIENT_LOGIN_PATH = '/client';

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
