// A stand-in for the Discord bot's listener, behaving as Endrig's documents say it does.
//
// It is a real HTTP server on a real port, so what the website's client does (headers, timeouts,
// dropped connections, HTML error pages from a proxy) is tested for real, not against a mock that
// only ever answers politely. The real listener is not written yet (25 Sep 2026); when it is, the
// same tests can be pointed at it by giving them its URL.
//
//   const bot = await startFakeBot({ token: 'secret' });
//   bot.url            -> 'http://127.0.0.1:<port>'
//   bot.requests       -> every request seen, in order
//   bot.notifications  -> notify bodies it accepted (not duplicates)
//   bot.failNext(2, 'error500')   -> the next two requests fail that way, then it recovers
//   bot.mode = 'hang'             -> every request fails that way until set back to 'ok'
//   await bot.close()
//
// Misbehaviours: 'error500', 'html502' (a proxy's page, not JSON), 'hang' (never answers),
// 'drop' (closes the connection), 'slow' (answers after bot.delayMs), 'badjson' (200 with a body
// that is not JSON).
import http from 'node:http';
import { validateNotify, validateLink, validateCampaignSync } from './bot-contract.mjs';

const DEDUPE_MS = 30 * 60 * 1000;   // "the same event_id within 30 minutes is silently dropped"
const ROUTES = new Set(['/notify', '/link', '/campaign-sync']);

export async function startFakeBot({
  token = 'fake-bot-token',
  forumConfigured = true,       // false -> /campaign-sync answers "not_configured"
  linkResult = 'joined',        // joined | already | discord_rejected | guild_unavailable | discord_error
  now = () => Date.now(),       // tests move this to step past the 30-minute dedupe window
  delayMs = 200
} = {}) {
  const bot = {
    token, forumConfigured, linkResult, now, delayMs,
    mode: 'ok', requests: [], notifications: [], links: [], syncs: 0,
    _seen: new Map(), _failures: []
  };

  bot.failNext = (count, kind) => { for (let i = 0; i < count; i++) bot._failures.push(kind); };
  bot.reset = () => { bot.requests.length = 0; bot.notifications.length = 0; bot.links.length = 0; bot.syncs = 0; bot._seen.clear(); bot._failures.length = 0; bot.mode = 'ok'; };

  const send = (res, status, body, type = 'application/json') => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('error', () => {});
    req.on('end', () => {
      const path = (req.url || '').split('?')[0];
      const raw = Buffer.concat(chunks).toString('utf8');
      const entry = { method: req.method, path, headers: { ...req.headers }, raw, body: undefined, status: null, at: bot.now() };
      bot.requests.push(entry);
      const reply = (status, body, type) => { entry.status = status; send(res, status, body, type); };

      // Unknown paths and wrong methods are answered as the documents say, before anything else.
      if (!ROUTES.has(path)) return reply(404, { ok: false, error: 'not_found' });
      if (req.method !== 'POST') return reply(405, { ok: false, error: 'method_not_allowed' });

      // Misbehaviour comes first: a real outage does not check the token politely.
      const kind = bot._failures.length ? bot._failures.shift() : bot.mode;
      switch (kind) {
        case 'error500': return reply(500, { ok: false, error: 'server_error' });
        case 'html502': return reply(502, '<html><body><h1>502 Bad Gateway</h1></body></html>', 'text/html');
        case 'badjson': return reply(200, 'this is not json');
        case 'drop': entry.status = 'dropped'; return req.socket.destroy();
        case 'hang': entry.status = 'hung'; return; // never answers; close() ends it
        case 'slow': return setTimeout(() => handle(), bot.delayMs);
        default: return handle();
      }

      function handle() {
        if (req.headers.authorization !== `Bearer ${bot.token}`) return reply(401, { ok: false, error: 'unauthorized' });

        let body;
        try { body = raw === '' ? {} : JSON.parse(raw); }
        catch { return reply(400, { ok: false, error: 'bad_request', message: 'The body must be valid JSON.' }); }
        entry.body = body;

        if (path === '/notify') {
          const v = validateNotify(body);
          if (!v.ok) return reply(400, { ok: false, error: v.error, message: v.message });
          if (body.event_id) {
            const at = bot._seen.get(body.event_id);
            if (at !== undefined && bot.now() - at < DEDUPE_MS) return reply(202, { ok: true, queued: false, duplicate: true });
            bot._seen.set(body.event_id, bot.now());
          }
          bot.notifications.push(body);
          return reply(202, { ok: true, queued: true, duplicate: false });
        }

        if (path === '/link') {
          const v = validateLink(body);
          if (!v.ok) return reply(400, { ok: false, error: v.error, message: v.message });
          bot.links.push({ discord_user_id: body.discord_user_id }); // the token is deliberately not kept
          switch (bot.linkResult) {
            case 'already': return reply(200, { ok: true, joined: false, alreadyMember: true });
            case 'discord_rejected': return reply(400, { ok: false, error: 'discord_rejected', message: 'Discord refused the join. The access token may have expired.' });
            case 'guild_unavailable': return reply(500, { ok: false, error: 'guild_unavailable' });
            case 'discord_error': return reply(502, { ok: false, error: 'discord_error' });
            default: return reply(200, { ok: true, joined: true, alreadyMember: false });
          }
        }

        // /campaign-sync
        const v = validateCampaignSync(body);
        if (!v.ok) return reply(400, { ok: false, error: v.error, message: v.message });
        if (!bot.forumConfigured) return reply(200, { ok: true, triggered: false, reason: 'not_configured' });
        bot.syncs++;
        return reply(202, { ok: true, triggered: true });
      }
    });
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  bot.port = server.address().port;
  bot.url = `http://127.0.0.1:${bot.port}`;
  bot.close = () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  return bot;
}
