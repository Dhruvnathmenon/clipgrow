import { now } from './db.js';

/**
 * The staff activity log (migration 023). Deliberately not wired into every
 * mutation in admin.js -- only the handful of action classes the founder
 * actually asked to see: clipper kicked, account removed, participation
 * paused, a refresh triggered, a clipper login created, an access request
 * approved. See admin.js's own comments at each call site for why that one
 * was included.
 *
 * staffId/reviewerId-style nullability: an admin session carries the
 * literal string 'admin' (auth.js createSessionCookie('admin','admin',...)),
 * not a real numeric staff row, so staffId is null and staffName is the
 * fixed string 'Admin' for every admin-attributed entry.
 */
export async function logAction(db, {
  staffType, staffId = null, staffName, action,
  targetType, targetId = null, targetLabel = null, detail = null
}) {
  await db.prepare(
    `INSERT INTO staff_audit_log
       (staff_type, staff_id, staff_name, action, target_type, target_id, target_label, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(staffType, staffId, staffName, action, targetType, targetId, targetLabel, detail, now()).run();
}

/** Paginated, newest first. `beforeId` continues from a prior page's last id. */
export async function listAuditLog(db, { limit = 50, beforeId = null } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const { results } = beforeId
    ? await db.prepare('SELECT * FROM staff_audit_log WHERE id < ? ORDER BY id DESC LIMIT ?')
        .bind(beforeId, capped).all()
    : await db.prepare('SELECT * FROM staff_audit_log ORDER BY id DESC LIMIT ?').bind(capped).all();
  return results || [];
}
