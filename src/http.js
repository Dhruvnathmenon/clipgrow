export function json(data, status = 200, extraHeaders = {}) {
  // API responses carry per-session data, so they must never be cached by the
  // edge, a proxy, or the browser -- a cached copy of an authorised response
  // would otherwise be served to an anonymous visitor.
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, private, max-age=0',
      ...extraHeaders
    }
  });
}

export function err(message, status = 400) {
  return json({ error: message }, status);
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export function matchPath(pattern, pathname) {
  const pParts = pattern.split('/').filter(Boolean);
  const parts = pathname.split('/').filter(Boolean);
  if (pParts.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < pParts.length; i++) {
    if (pParts[i].startsWith(':')) params[pParts[i].slice(1)] = parts[i];
    else if (pParts[i] !== parts[i]) return null;
  }
  return params;
}
