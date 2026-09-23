// The one door the Discord bot (Clipcore) uses to ask ClipGrow anything.
//
// The bot runs on a game-hosting node outside ClipGrow's control, so this file is
// written on the assumption that whatever calls it may one day be someone else.
// That shapes every choice below:
//
//   * The bot asks a question from a CLOSED list (INTENTS), naming only which
//     Discord account is asking. There is no field to select, no query to run and
//     no way to name a different person, so there is nothing to inject into.
//   * ClipGrow builds the finished sentences. The bot only prints them.
//   * Nothing about money is ever returned: no earnings, no budgets, no amounts.
//     Anything financial stays on the dashboard. Nothing about anyone but the
//     asker is returned either.
//   * A leaked token is worth very little (coarse status for linked clippers) and
//     is noticed quickly (volumeBreaker), and rotating it is one secret.
//
// Contract: docs/bot-api-contract.md. The Clipcore side is exercised against the
// same shapes in its own tests.
import { json } from './http.js';
import { applicationState, MAX_ATTEMPTS } from './applications.js';
import { profileProblems } from '../components/profile-validation.js';
import { logError } from './error-log.js';
import { now } from './db.js';

// What the bot may ask. Adding a question means adding it here AND writing the
// answer below, in this repo -- the bot cannot widen what it can reach on its own.
export const INTENTS = ['status'];

export const BOT_LIMITS = { windowMs: 10 * 60 * 1000, maxCalls: 600, maxDistinct: 150 };

const SNOWFLAKE = /^\d{15,25}$/;
const DAY = 24 * 60 * 60 * 1000;
export const DASHBOARD_URL = 'https://clipgrow.in/dashboard';

const botErr = (code, message, status) => json({ error: code, message }, status);

/* --------------------------------------------------------------------- auth */

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Compares digests rather than the raw strings, so neither the length nor the
// position of the first wrong character shows in how long the answer takes.
export async function botTokenOk(request, env) {
  const header = request.headers.get('Authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m || !env.BOT_API_TOKEN) return false;
  const [a, b] = await Promise.all([sha256Hex(m[1].trim()), sha256Hex(String(env.BOT_API_TOKEN))]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* --------------------------------------------------------------- the breaker */

async function subjectHash(env, subject) {
  return (await sha256Hex(`${env.SESSION_SECRET}|bot|${subject}`)).slice(0, 32);
}

// Records the call and reports whether the volume is past what real use looks like.
// Recorded even when refused, so a hammering caller keeps the window full.
export async function volumeBreaker(env, subject, at = now()) {
  const hash = await subjectHash(env, subject);
  await env.DB.prepare('INSERT INTO bot_api_calls (ts, subject_hash) VALUES (?, ?)').bind(at, hash).run();
  await env.DB.prepare('DELETE FROM bot_api_calls WHERE ts < ?').bind(at - DAY).run();
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS calls, COUNT(DISTINCT subject_hash) AS distinct_subjects FROM bot_api_calls WHERE ts > ?'
  ).bind(at - BOT_LIMITS.windowMs).first();
  const tripped = row.calls > BOT_LIMITS.maxCalls || row.distinct_subjects > BOT_LIMITS.maxDistinct;
  return { tripped, calls: row.calls, distinct: row.distinct_subjects };
}

// Tell the admin once per window, not once per refused call.
async function reportBreaker(env, volume, at = now()) {
  const recent = await env.DB.prepare(
    "SELECT 1 AS x FROM error_log WHERE source = 'bot_api' AND code = 'VOLUME' AND created_at > ?"
  ).bind(at - BOT_LIMITS.windowMs).first();
  if (recent) return;
  await logError(env.DB, {
    actorType: 'system', source: 'bot_api', code: 'VOLUME',
    message: `The bot API refused requests: ${volume.calls} calls about ${volume.distinct} different people in ten minutes.`,
    detail: 'Far above normal use. If the bot is fine, its token may have leaked: rotate BOT_API_TOKEN.'
  });
}

/* -------------------------------------------------------------- the answers */

// Display strings end up in a shared Discord channel, so anything an admin or a
// clipper typed is neutralised: markdown is escaped and an @ can never become a
// mention. The bot also sends with mentions disabled; this is the second lock.
export function safe(text) {
  return String(text == null ? '' : text)
    .replace(/[\\`*_~|>#[\]()]/g, m => '\\' + m)
    .replace(/@/g, '@\u200b')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 80);
}

const FIELD_NAMES = {
  email: 'email', contact_number: 'contact number', upi_id: 'UPI ID',
  upi_account_name: 'name on the UPI account', legal_name: 'legal name', discord_username: 'Discord username'
};

// One campaign, one line: where this person is and what to do next.
export function campaignLine({ name, participation, app, connected, needsReconnect, campaignStatus }) {
  const n = `**${safe(name)}**`;
  if (participation === 'kicked') return `• ${n} — ⛔ removed. Contact the ClipGrow admin.`;
  if (app.state === 'exhausted') return `• ${n} — ⛔ not approved after ${MAX_ATTEMPTS} tries.`;
  if (connected && needsReconnect) return `• ${n} — ⚠️ live, but an account needs reconnecting. Open your dashboard.`;
  if (connected) return `• ${n} — ✅ live. Your views are being counted.`;
  if (app.state === 'approved') return `• ${n} — ➡️ video approved. Next: connect the account you'll post from.`;
  if (app.state === 'pending') return `• ${n} — ⏳ video waiting for a reviewer.`;
  if (app.state === 'rejected') {
    const left = app.attempts_left;
    return `• ${n} — ✏️ changes needed (${left} ${left === 1 ? 'try' : 'tries'} left). The reviewer's note is on your dashboard.`;
  }
  if (campaignStatus === 'budget_full') return `• ${n} — closed to new clippers for now.`;
  return `• ${n} — ➡️ next: send your video for review.`;
}

async function buildStatus(env, clipper) {
  const db = env.DB;
  const lines = [];
  lines.push(`Signed in as **${safe(clipper.display_name || clipper.username)}**${clipper.discord_handle ? ` · Discord @${safe(clipper.discord_handle)}` : ''}`);

  if (clipper.status !== 'active') {
    lines.push('⚠️ This account is disabled, so nothing new can be started. Contact the ClipGrow admin. You can still see what you have earned on your dashboard.');
    lines.push(DASHBOARD_URL);
    return lines;
  }

  const missing = profileProblems(clipper).map(p => FIELD_NAMES[p.key] || p.label.toLowerCase());
  lines.push(missing.length
    ? `📝 Details needed: ${missing.join(', ')}. Add ${missing.length === 1 ? 'it' : 'them'} in Your Details on the dashboard.`
    : '✅ Your details are complete.');

  const { results: rows } = await db.prepare(
    `SELECT p.id AS participation_id, p.status AS participation_status, c.id AS campaign_id, c.name, c.status AS campaign_status
       FROM participations p JOIN campaigns c ON c.id = p.campaign_id
      WHERE p.clipper_id = ? AND c.status != 'completed'
      ORDER BY c.name COLLATE NOCASE`
  ).bind(clipper.id).all();
  const mine = rows || [];

  if (mine.length) {
    lines.push('**Your campaigns**');
    for (const r of mine) {
      const app = await applicationState(db, clipper.id, r.campaign_id);
      const acc = await db.prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN sa.status = 'needs_reauth' THEN 1 ELSE 0 END) AS bad
           FROM participation_accounts pa JOIN social_accounts sa ON sa.id = pa.account_id
          WHERE pa.participation_id = ? AND sa.status != 'revoked'`
      ).bind(r.participation_id).first();
      lines.push(campaignLine({
        name: r.name, participation: r.participation_status, app,
        connected: (acc && acc.n) > 0, needsReconnect: (acc && acc.bad) > 0, campaignStatus: r.campaign_status
      }));
    }
  } else {
    lines.push("You haven't joined a campaign yet.");
  }

  const open = await db.prepare(
    `SELECT COUNT(*) AS n FROM campaigns c
      WHERE c.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM participations p WHERE p.campaign_id = c.id AND p.clipper_id = ?)`
  ).bind(clipper.id).first();
  if (open && open.n > 0) lines.push(`${open.n} more ${open.n === 1 ? 'campaign is' : 'campaigns are'} open. See the campaign list.`);

  lines.push(DASHBOARD_URL);
  return lines;
}

// The public shape of a campaign for the campaign-list channel: what the marketing
// site already shows anyone, and never budget, spend or client details.
export async function openCampaigns(db) {
  const { results } = await db.prepare(
    `SELECT id, name, cpm, min_views, allowed_platforms FROM campaigns WHERE status = 'active' ORDER BY created_at DESC`
  ).all();
  return (results || []).map(c => ({
    id: c.id, name: safe(c.name), cpm: c.cpm, min_views: c.min_views || 0,
    platforms: String(c.allowed_platforms || '').split(',').map(s => s.trim()).filter(Boolean)
  }));
}

/* ------------------------------------------------------------------ routing */

export async function handleBot(request, env, url) {
  const { pathname } = url;
  if (!pathname.startsWith('/api/bot/')) return null;

  // Off until a token exists: nothing to guess, nothing answering.
  if (!env.BOT_API_TOKEN) return botErr('bot_api_disabled', 'The bot API is not switched on.', 503);
  if (!(await botTokenOk(request, env))) return botErr('unauthorized', 'Missing or wrong token.', 401);

  const method = request.method;

  if (pathname === '/api/bot/ping') {
    if (method !== 'GET') return botErr('method_not_allowed', 'Use GET.', 405);
    return json({ ok: true, at: now() });
  }

  if (pathname === '/api/bot/campaigns') {
    if (method !== 'GET') return botErr('method_not_allowed', 'Use GET.', 405);
    const volume = await volumeBreaker(env, 'campaigns');
    if (volume.tripped) { await reportBreaker(env, volume); return botErr('rate_limited', 'Too many requests. Try again in a few minutes.', 429); }
    return json({ campaigns: await openCampaigns(env.DB), at: now() });
  }

  if (pathname === '/api/bot/answer') {
    if (method !== 'POST') return botErr('method_not_allowed', 'Use POST.', 405);
    let body;
    try { body = await request.json(); } catch { return botErr('bad_request', 'The body must be JSON.', 400); }
    if (!body || typeof body !== 'object') return botErr('bad_request', 'The body must be a JSON object.', 400);
    const id = typeof body.discord_user_id === 'string' ? body.discord_user_id : '';
    if (!SNOWFLAKE.test(id)) return botErr('bad_request', 'discord_user_id must be a Discord user id (digits, as a string).', 400);
    if (!INTENTS.includes(body.intent)) return botErr('unknown_intent', `intent must be one of: ${INTENTS.join(', ')}.`, 400);

    const volume = await volumeBreaker(env, id);
    if (volume.tripped) { await reportBreaker(env, volume); return botErr('rate_limited', 'Too many requests. Try again in a few minutes.', 429); }

    const clipper = await env.DB.prepare(
      "SELECT * FROM clippers WHERE discord_user_id = ? AND status != 'deleted'"
    ).bind(id).first();
    if (!clipper) {
      // The same answer for "never linked" and "does not exist": it says nothing
      // about anyone, only what to do next.
      return json({
        linked: false,
        lines: ["I can't find a ClipGrow account linked to this Discord account.",
          'Log in at https://clipgrow.in/clipper and choose **Connect Discord** in Your Details.']
      });
    }
    return json({ linked: true, lines: await buildStatus(env, clipper) });
  }

  return botErr('not_found', 'No such bot endpoint.', 404);
}
