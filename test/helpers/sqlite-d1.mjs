// A D1-compatible database backed by real SQLite, loaded with the real schema.
//
// The hand-written fakes (fake-d1, fake-payouts-db) match queries by shape and
// throw on anything unrecognised, which makes them unusable for testing code
// that issues arbitrary SQL -- and, worse, they can only ever confirm the
// queries someone already thought of. This runs the actual statements against
// the actual schema, so a query that would fail in production fails here.
import { buildSchema } from './real-schema.mjs';

/** @returns a D1-shaped database: prepare().bind().first()/.all()/.run(), batch(). */
export function makeSqliteD1(seed = {}) {
  const { db } = buildSchema();

  const wrap = (sql) => {
    let args = [];
    const stmt = {
      bind: (...a) => { args = a.map(norm); return stmt; },
      async all() {
        const rows = db.prepare(sql).all(...args);
        // SQLite has no native "rows read" concept -- row count is a
        // deliberate, documented stand-in for real D1's meta.rows_read, so
        // test/d1-usage.test.mjs can exercise wrapD1's real accumulation
        // logic against this fake instead of only against a hand-rolled one.
        return { results: rows, meta: { rows_read: rows.length } };
      },
      async first() {
        const row = db.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      async run() {
        const r = db.prepare(sql).run(...args);
        // Same stand-in as .all() above, mirrored for writes.
        return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid), rows_read: 0, rows_written: r.changes } };
      },
      // Exposed so batch() can execute without re-binding.
      _exec: () => db.prepare(sql).run(...args)
    };
    return stmt;
  };

  // node:sqlite rejects undefined and booleans; D1 accepts both.
  const norm = (v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  };

  const api = {
    prepare: wrap,
    async batch(stmts) {
      // D1 runs a batch in one transaction; mirror that so a partial failure
      // cannot leave half-applied state that the real thing would roll back.
      db.exec('BEGIN');
      try {
        const out = stmts.map(s => {
          const r = s._exec();
          return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid), rows_read: 0, rows_written: r.changes } };
        });
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    /** Escape hatch for assertions. */
    _sqlite: db,
    _rows: (table) => db.prepare(`SELECT * FROM ${table}`).all()
  };

  for (const [table, rows] of Object.entries(seed)) {
    for (const row of rows) {
      const cols = Object.keys(row);
      db.prepare(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
      ).run(...cols.map(c => norm(row[c])));
    }
  }
  return api;
}
