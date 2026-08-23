// Builds the project's REAL schema in an in-memory SQLite database, by
// applying schema.sql and then every migration in numeric order -- exactly the
// sequence a fresh production database went through.
//
// Why this exists: every query in this project is a raw SQL string with no ORM
// and no type checking, so a reference to a column that was never added (or was
// renamed) is invisible until that code path runs in production. With the real
// schema in hand, SQLite's own parser can validate a query at prepare() time
// without executing it -- which turns a whole class of runtime bugs into test
// failures.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Splits a .sql file into statements, ignoring `--` comments. */
function statements(sql) {
  return sql
    .split('\n')
    .filter(l => !/^\s*--/.test(l))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}

export function migrationFiles() {
  return readdirSync(join(ROOT, 'migrations'))
    .filter(f => f.endsWith('.sql'))
    .sort();   // zero-padded numeric prefixes sort correctly
}

/**
 * @returns {{db: DatabaseSync, applied: string[]}} an in-memory database with
 * the full schema applied, and the list of files applied in order.
 */
export function buildSchema() {
  const db = new DatabaseSync(':memory:');
  const applied = [];

  for (const stmt of statements(readFileSync(join(ROOT, 'schema.sql'), 'utf8'))) {
    db.exec(stmt);
  }
  applied.push('schema.sql');

  for (const file of migrationFiles()) {
    const sql = readFileSync(join(ROOT, 'migrations', file), 'utf8');
    for (const stmt of statements(sql)) {
      try {
        db.exec(stmt);
      } catch (e) {
        // A migration that re-adds an existing column is expected to be a
        // no-op on an already-migrated database, and some early migrations
        // overlap with schema.sql. Anything else is a real schema fault.
        if (/duplicate column name|already exists/i.test(e.message)) continue;
        throw new Error(`${file}: ${e.message}\n  statement: ${stmt.slice(0, 200)}`);
      }
    }
    applied.push(file);
  }
  return { db, applied };
}

/** Every table name in the built schema. */
export function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all().map(r => r.name).sort();
}

/** Column names for one table. */
export function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
}
