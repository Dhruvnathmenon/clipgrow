// D1 (SQLite) refuses a statement with more than 100 bound parameters, and it
// fails with a bare "too many SQL variables" -- which surfaced to the admin as
// "Internal server error" the first time a payout selected more than 100 clips.
// Anything that puts a list of ids into an IN (...) must go through these so
// the list can grow without ever hitting the wall.

// Comfortably under D1's limit of 100, leaving room for the other bound values
// a statement carries alongside the ids.
export const MAX_IN_PARAMS = 90;

export function chunk(items, size = MAX_IN_PARAMS) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Runs `sql` once per chunk of `ids` and concatenates the rows. `{IN}` in the
 * SQL is replaced with the right number of placeholders; `extra` values (bound
 * BEFORE the ids) are for any leading parameters.
 */
export async function selectByIds(db, sql, ids, extra = []) {
  const rows = [];
  for (const part of chunk(ids)) {
    const { results } = await db
      .prepare(sql.replace('{IN}', part.map(() => '?').join(',')))
      .bind(...extra, ...part).all();
    if (results) rows.push(...results);
  }
  return rows;
}

/** One prepared statement per chunk, for writes that go into a db.batch(). */
export function statementsByIds(db, sql, ids, extra = []) {
  return chunk(ids).map(part =>
    db.prepare(sql.replace('{IN}', part.map(() => '?').join(','))).bind(...extra, ...part));
}
