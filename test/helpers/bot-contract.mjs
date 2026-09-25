// The bot's contracts, as code.
//
// Every rule here comes from Endrig's documents (docs/endrig/*.md). Where a document
// states a rule ("title max 256 chars", "both fields required") it is enforced exactly.
// Where it says nothing but Discord itself has a limit, the limit is enforced and marked
// DISCORD below, so a failure says which of the two it was.
//
// Two things use this: the fake bot (test/helpers/fake-bot.mjs) answers the way the real bot
// is documented to, and the tests hold every payload the website builds up against it, so a
// change to a message that the bot would refuse is caught by `npm test`, not by a clipper.

export const SNOWFLAKE = /^\d{17,20}$/;
export const NOTIFY_TYPES = ['submission_approved', 'submission_rejected', 'payout_sent', 'custom'];

// The forum contract: any of these words means paused / over; anything else is live.
const PAUSED_WORDS = ['paused', 'pause', 'on_hold', 'hold'];
const OVER_WORDS = ['over', 'closed', 'ended', 'complete', 'completed', 'finished'];

// DISCORD: an embed field value, a thread name and an embed description all have hard limits.
export const LIMITS = {
  title: 256,            // documented, for `custom`
  description: 4096,     // documented, for `custom`
  text: 1024,            // DISCORD: embed field value, applied to every other free-text field
  threadName: 100,       // DISCORD: forum thread name
  eventId: 128,          // ours: the docs say "any stable string", so we keep it short and sane
  listItems: 25,         // DISCORD: fields per embed
  embedTotal: 6000       // DISCORD: characters across one embed
};

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = v => typeof v === 'string' && v.trim().length > 0;
const isHttpUrl = v => {
  if (typeof v !== 'string') return false;
  try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
};

/** The bot's reading of a status word, so a test can say what the thread will show. */
export function normaliseStatus(status) {
  const s = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (PAUSED_WORDS.includes(s)) return 'paused';
  if (OVER_WORDS.includes(s)) return 'over';
  return 'live';
}

/** `<emoji> <name> (<STATUS>)`, the thread title the forum contract describes. */
export function threadTitle({ emoji, name, status }) {
  return `${emoji && String(emoji).trim() ? String(emoji).trim() : '📋'} ${name} (${normaliseStatus(status).toUpperCase()})`;
}

/* ------------------------------------------------------------------ /notify */

function optionalText(body, key, errors) {
  if (body[key] === undefined || body[key] === null) return;
  if (typeof body[key] !== 'string') errors.push(`${key} must be a string`);
  else if (body[key].length > LIMITS.text) errors.push(`${key} is over ${LIMITS.text} characters (DISCORD field limit)`);
}

function requiredText(body, key, errors, max = LIMITS.text) {
  if (!isText(body[key])) { errors.push(`${key} is required`); return; }
  if (body[key].length > max) errors.push(`${key} is over ${max} characters`);
}

/**
 * Validates one POST /notify body. Returns { ok: true } or { ok: false, error, message }, where
 * `error` is the code the bot documents (bad_request, bad_snowflake) and `message` says exactly what is wrong.
 */
export function validateNotify(body) {
  if (!isObject(body)) return { ok: false, error: 'bad_request', message: 'The body must be a JSON object.' };
  const errors = [];

  if (typeof body.discord_user_id !== 'string' || !SNOWFLAKE.test(body.discord_user_id)) {
    return { ok: false, error: 'bad_snowflake', message: 'discord_user_id must be a Discord user id (17-20 digits, as a string).' };
  }
  if (!NOTIFY_TYPES.includes(body.type)) {
    return { ok: false, error: 'bad_request', message: `type must be one of: ${NOTIFY_TYPES.join(', ')}.` };
  }
  if (body.event_id !== undefined && body.event_id !== null) {
    if (typeof body.event_id !== 'string' || !body.event_id.trim()) errors.push('event_id must be a non-empty string');
    else if (body.event_id.length > LIMITS.eventId) errors.push(`event_id is over ${LIMITS.eventId} characters`);
  }

  switch (body.type) {
    case 'submission_approved':
      requiredText(body, 'campaign', errors);
      optionalText(body, 'platform', errors);
      if (body.views !== undefined && body.views !== null && !(Number.isFinite(body.views) && body.views >= 0)) errors.push('views must be a number, zero or more');
      if (body.clip_url !== undefined && body.clip_url !== null && !isHttpUrl(body.clip_url)) errors.push('clip_url must be an http(s) link');
      break;
    case 'submission_rejected':
      requiredText(body, 'campaign', errors);
      requiredText(body, 'reason', errors);
      if (body.resubmit_url !== undefined && body.resubmit_url !== null && !isHttpUrl(body.resubmit_url)) errors.push('resubmit_url must be an http(s) link');
      break;
    case 'payout_sent':
      if (!(typeof body.amount_inr === 'number' && Number.isFinite(body.amount_inr) && body.amount_inr > 0)) errors.push('amount_inr is required and must be a number above zero (no currency symbol)');
      optionalText(body, 'campaign', errors);
      optionalText(body, 'method', errors);
      optionalText(body, 'note', errors);
      break;
    case 'custom':
      requiredText(body, 'title', errors, LIMITS.title);
      requiredText(body, 'description', errors, LIMITS.description);
      if (body.color !== undefined && body.color !== null) {
        const c = body.color;
        const hex = typeof c === 'string' && /^#?[0-9a-fA-F]{6}$/.test(c);
        const num = typeof c === 'number' && Number.isInteger(c) && c >= 0 && c <= 0xffffff;
        if (!hex && !num) errors.push('color must be a hex string like "#5865f2" or a number');
      }
      break;
  }
  return errors.length ? { ok: false, error: 'bad_request', message: errors.join('; ') + '.' } : { ok: true };
}

/* -------------------------------------------------------------------- /link */

export function validateLink(body) {
  if (!isObject(body)) return { ok: false, error: 'bad_request', message: 'The body must be a JSON object.' };
  if (typeof body.discord_user_id !== 'string' || !SNOWFLAKE.test(body.discord_user_id)) {
    return { ok: false, error: 'bad_snowflake', message: 'discord_user_id must be a Discord user id (17-20 digits, as a string).' };
  }
  if (typeof body.access_token !== 'string' || body.access_token.trim().length < 10) {
    return { ok: false, error: 'bad_access_token', message: 'access_token is required.' };
  }
  return { ok: true };
}

/* ------------------------------------------------------------ /campaign-sync */

/** `{}` is fine; campaign_id is optional and only used for the bot's log. */
export function validateCampaignSync(body) {
  if (!isObject(body)) return { ok: false, error: 'bad_request', message: 'The body must be a JSON object.' };
  if (body.campaign_id !== undefined && body.campaign_id !== null && !(Number.isInteger(body.campaign_id) && body.campaign_id > 0)) {
    return { ok: false, error: 'bad_request', message: 'campaign_id, when sent, must be a positive whole number.' };
  }
  return { ok: true };
}

/* ------------------------------------------- GET /api/bot/campaigns (forum) */

const TEXT_FIELDS = ['emoji', 'payout_note', 'source_footage', 'important_note', 'help_text'];
const URL_FIELDS = ['logo_url', 'source_footage_link', 'apply_url'];
const NUMBER_FIELDS = ['budget_total', 'budget_consumed', 'clippers_enrolled', 'max_payout_per_video'];
const LIST_FIELDS = ['cta', 'dos', 'donts', 'inspiration_links'];
export const FORUM_FIELDS = ['id', 'name', 'cpm', 'min_views', 'platforms', 'status', ...TEXT_FIELDS, ...URL_FIELDS, ...NUMBER_FIELDS, ...LIST_FIELDS];

/**
 * One entry of the `campaigns` array. Everything but id and name is optional (the bot leaves a
 * missing field out of the post), but what IS sent must be the right type and fit Discord.
 * Returns an array of problems, empty when the entry is fine.
 */
export function forumCampaignProblems(c) {
  const p = [];
  if (!isObject(c)) return ['a campaign must be an object'];
  if (!(Number.isInteger(c.id) && c.id > 0)) p.push('id must be a positive whole number that never changes');
  if (!isText(c.name)) p.push('name is required');
  if (c.status !== undefined && !['live', 'paused', 'over'].includes(c.status)) p.push(`status "${c.status}" must be live, paused or over (the website sends it already normalised)`);
  if (c.cpm !== undefined && !(Number.isFinite(c.cpm) && c.cpm >= 0)) p.push('cpm must be a number');
  if (c.min_views !== undefined && !(Number.isFinite(c.min_views) && c.min_views >= 0)) p.push('min_views must be a number');
  if (c.platforms !== undefined && !(Array.isArray(c.platforms) && c.platforms.every(x => typeof x === 'string'))) p.push('platforms must be a list of strings');

  for (const k of TEXT_FIELDS) {
    if (c[k] === undefined) continue;
    if (typeof c[k] !== 'string') p.push(`${k} must be a string`);
    else if (c[k].length > LIMITS.text) p.push(`${k} is over ${LIMITS.text} characters`);
  }
  for (const k of URL_FIELDS) {
    if (c[k] === undefined) continue;
    if (!isHttpUrl(c[k])) p.push(`${k} must be an http(s) link`);
    // Discord will not fetch a thumbnail over plain http on most clients, and the site is https-only.
    else if (k === 'logo_url' && !c[k].startsWith('https://')) p.push('logo_url must be https');
  }
  for (const k of NUMBER_FIELDS) {
    if (c[k] === undefined) continue;
    if (!(Number.isFinite(c[k]) && c[k] >= 0)) p.push(`${k} must be a number, zero or more`);
  }
  if (Number.isFinite(c.budget_total) && Number.isFinite(c.budget_consumed) && c.budget_consumed > c.budget_total) {
    p.push('budget_consumed is more than budget_total, so "Budget left" would be negative');
  }
  if (c.clippers_enrolled !== undefined && !Number.isInteger(c.clippers_enrolled)) p.push('clippers_enrolled must be a whole number');
  for (const k of LIST_FIELDS) {
    if (c[k] === undefined) continue;
    if (!Array.isArray(c[k]) || !c[k].every(x => typeof x === 'string')) { p.push(`${k} must be a list of strings`); continue; }
    if (c[k].length > LIMITS.listItems) p.push(`${k} has more than ${LIMITS.listItems} items`);
    if (c[k].some(x => x.length > LIMITS.text)) p.push(`an item in ${k} is over ${LIMITS.text} characters`);
    if (k === 'inspiration_links' && c[k].some(x => !isHttpUrl(x))) p.push('inspiration_links must all be http(s) links');
  }

  if (isText(c.name)) {
    const title = threadTitle({ emoji: c.emoji, name: c.name, status: c.status });
    if (title.length > LIMITS.threadName) p.push(`the thread title "${title.slice(0, 30)}…" is ${title.length} characters and Discord allows ${LIMITS.threadName}`);
  }

  // Everything the embed will carry, roughly, against Discord's total.
  const total = [...TEXT_FIELDS, ...URL_FIELDS].reduce((n, k) => n + (typeof c[k] === 'string' ? c[k].length : 0), 0)
    + LIST_FIELDS.reduce((n, k) => n + (Array.isArray(c[k]) ? c[k].reduce((m, x) => m + (typeof x === 'string' ? x.length : 0), 0) : 0), 0);
  if (total > LIMITS.embedTotal) p.push(`the post text is about ${total} characters and one Discord embed holds ${LIMITS.embedTotal}`);
  return p;
}

/** The whole response of GET /api/bot/campaigns. */
export function forumListProblems(body) {
  if (!isObject(body) || !Array.isArray(body.campaigns)) return ['the response must be { campaigns: [...] }'];
  const problems = [];
  const seen = new Set();
  body.campaigns.forEach((c, i) => {
    for (const x of forumCampaignProblems(c)) problems.push(`campaigns[${i}]: ${x}`);
    if (c && seen.has(c.id)) problems.push(`campaigns[${i}]: id ${c.id} appears twice, so the bot would treat them as one campaign`);
    if (c) seen.add(c.id);
  });
  return problems;
}
