import { handleAdmin } from './routes/admin.js';
import { handleClipper } from './routes/clipper.js';
import { handleInstagramAuth } from './routes/instagram-auth.js';
import { handlePublic } from './routes/public.js';
import { syncAllCampaigns } from './earnings.js';
import { err } from './http.js';

const handlers = [handleInstagramAuth, handleAdmin, handleClipper, handlePublic];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      for (const handler of handlers) {
        try {
          const res = await handler(request, env, url);
          if (res) return res;
        } catch (e) {
          console.error(`handler error on ${url.pathname}:`, e.stack || e.message);
          return err('Internal server error', 500);
        }
      }
      return err('Not found', 404);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncAllCampaigns(env.DB));
  }
};
