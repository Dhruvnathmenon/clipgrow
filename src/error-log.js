// A durable record of things that actually go wrong for a real person using
// the site -- a clipper, a moderator, or an admin -- so the founder has one
// place to look instead of asking "what happened?" with no way to answer it.
// Two kinds of failure feed this:
//
// 1. OAuth connect failures (instagram-auth.js / youtube-auth.js's own
//    `failure()` helpers). These are HANDLED -- caught internally and turned
//    into a one-time toast on the dashboard -- so nothing here ever sees them
//    unless those call sites explicitly log. Before this module existed they
//    were never recorded anywhere at all.
// 2. Any uncaught exception from an API route (worker.js's top-level
//    try/catch around every handler). This is a safety net: it catches
//    whatever breaks next, not just the two failure modes anyone thought of
//    today -- the same property CLAUDE.md's testing discipline aims for
//    elsewhere.
//
// Deliberately NOT logged: routine 4xx validation ("status field required"),
// and the two OAuth outcomes that are normal flow, not a problem --
// NOT_APPROVED (they just haven't been approved yet) and DENIED (they
// cancelled the permission screen; they just try again). See SILENT_CODES in
// the two auth route files.
import { now } from './db.js';

export const ERROR_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * actorLabel is denormalised at write time, the same way staff_audit_log
 * already denormalises a moderator's display name (migration 023) -- an
 * account renamed or deactivated later should not rewrite what this error
 * said about them at the time. Contact info (WhatsApp/Discord) for the
 * "message them" button is deliberately NOT stored here; listErrors joins
 * it live so an updated number always gets used.
 */
export async function logError(db, {
  actorType, actorId = null, actorLabel = null,
  source, code = null, message, detail = null, path = null
}) {
  try {
    await db.prepare(
      `INSERT INTO error_log (actor_type, actor_id, actor_label, source, code, message, detail, path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(actorType, actorId, actorLabel, source, code, message, detail, path, now()).run();
  } catch (e) {
    // Logging a failure must never itself become the failure the request
    // fails with -- worst case, this one error goes unrecorded.
    console.error('logError failed:', e && e.message);
  }
}

/** Newest first. `unresolvedOnly` is what the admin panel shows by default. */
export async function listErrors(db, { limit = 200, unresolvedOnly = false } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const where = unresolvedOnly ? 'WHERE resolved_at IS NULL' : '';
  const { results } = await db.prepare(
    `SELECT * FROM error_log ${where} ORDER BY id DESC LIMIT ?`
  ).bind(capped).all();
  return results || [];
}

/** Idempotent -- resolving an already-resolved (or missing) row is a no-op. */
export async function resolveError(db, id, { resolved = true } = {}) {
  const res = resolved
    ? await db.prepare('UPDATE error_log SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').bind(now(), id).run()
    : await db.prepare('UPDATE error_log SET resolved_at = NULL WHERE id = ? AND resolved_at IS NOT NULL').bind(id).run();
  return (res.meta && res.meta.changes) > 0;
}

/** Hard delete, per the founder's own call -- nothing to archive or manage later. */
export async function pruneErrorLog(db, { now: n = Date.now() } = {}) {
  const cutoff = n - ERROR_LOG_RETENTION_MS;
  const res = await db.prepare('DELETE FROM error_log WHERE created_at < ?').bind(cutoff).run();
  return (res.meta && res.meta.changes) || 0;
}
