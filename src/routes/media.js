import { matchPath } from '../http.js';
import { serveThumbnail } from '../media.js';

// Clip thumbnails are previews of public Instagram posts, so they are served
// without auth -- the public leaderboard shows them too.
export async function handleMedia(request, env, url) {
  if (request.method !== 'GET') return null;

  const params = matchPath('/api/media/thumb/:id', url.pathname);
  if (!params) return null;

  const row = await env.DB
    .prepare('SELECT thumbnail_key, thumbnail_url FROM submissions WHERE id = ?')
    .bind(params.id)
    .first();
  if (!row) return new Response(null, { status: 404 });

  return serveThumbnail(env, row.thumbnail_key, row.thumbnail_url);
}
