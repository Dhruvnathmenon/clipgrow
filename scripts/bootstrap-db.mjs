#!/usr/bin/env node
// Builds a D1 database from scratch: schema.sql (the pre-migration-002
// baseline) followed by every file in migrations/, in filename order --
// exactly the sequence the real production database went through, and
// exactly what test/helpers/real-schema.mjs already does for the test
// suite's in-memory database.
//
// Why this exists: `db:schema` used to just run schema.sql alone, and
// schema.sql had been stale for a long time -- it still defined a
// campaign_optins table that no longer exists (renamed to `participations`
// early on) and was missing 11+ columns since added to `campaigns`. Running
// only schema.sql left you with a database that didn't match the app at
// all. This can't go stale the same way: it always replays the full, real
// history, so it's only ever as current as the migrations/ folder itself.
//
// Safe to re-run against an already-migrated database -- a file that only
// re-adds an existing column or re-creates an existing table is treated as
// a no-op, same tolerance test/helpers/real-schema.mjs applies, since some
// early migrations overlap with schema.sql by design.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const remote = process.argv.includes('--remote');
const flags = remote ? ['--remote'] : [];
const DB_NAME = 'clipgrow';

const BENIGN = /duplicate column name|already exists/i;

function run(label, file) {
  process.stdout.write(`→ ${label}\n`);
  try {
    execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', DB_NAME, ...flags, `--file=${file}`],
      // npx resolves to npx.cmd on Windows -- execFileSync can't launch a
      // .cmd directly without going through a shell.
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true }
    );
  } catch (e) {
    const output = `${e.stdout || ''}${e.stderr || ''}` || e.message;
    if (BENIGN.test(output)) {
      process.stdout.write(`  (already applied, skipping)\n`);
      return;
    }
    process.stderr.write(output + '\n');
    throw new Error(`${label} failed -- see output above.`);
  }
}

run('schema.sql', join(ROOT, 'schema.sql'));

const files = readdirSync(join(ROOT, 'migrations'))
  .filter(f => f.endsWith('.sql'))
  .sort(); // zero-padded numeric prefixes sort correctly

for (const f of files) run(`migrations/${f}`, join(ROOT, 'migrations', f));

console.log(`\n✓ schema.sql + ${files.length} migration(s) applied to ${remote ? 'the REMOTE' : 'the local'} "${DB_NAME}" database.`);
