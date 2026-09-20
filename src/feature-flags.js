// Feature flags: one row per switch, flipped by an admin without a redeploy.
//
// Reads fail OPEN (a missing row or an unreadable table reads as "off"). A
// flag exists to gate something new; if the flag store itself misbehaves the
// right outcome is the pre-existing behaviour, never a lockout.
import { now } from './db.js';

export const APPLICATIONS_GATE = 'applications_gate';

export async function flagEnabled(db, key) {
  try {
    const row = await db.prepare('SELECT enabled FROM feature_flags WHERE key = ?').bind(key).first();
    return !!(row && row.enabled);
  } catch (e) {
    console.error('feature flag read failed, treating as off:', key, e && e.message);
    return false;
  }
}

export async function listFlags(db) {
  const { results } = await db.prepare('SELECT key, enabled, updated_at, updated_by FROM feature_flags ORDER BY key').all();
  return (results || []).map(r => ({ ...r, enabled: !!r.enabled }));
}

export async function setFlag(db, key, enabled, by) {
  await db.prepare(
    `INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).bind(key, enabled ? 1 : 0, now(), by || null).run();
}
