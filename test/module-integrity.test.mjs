import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/*
 * Catches the "refactor left a dangling reference" bug class at test time
 * rather than in production.
 *
 * This project has no build step, no bundler and no type checker, so a module
 * that imports a name another module no longer exports is a perfectly valid
 * file on disk -- it only fails when Cloudflare tries to link the worker, or
 * worse, when a specific route is first hit. A real instance shipped: after the
 * chained-refresh refactor, earnings.js still exported syncAllCampaigns, which
 * referenced helpers that had been deleted.
 *
 * Simply importing every module makes Node's own ESM linker do the work: a
 * missing export throws at link time with the exact name, and a syntax error
 * throws too. No heuristics, no false positives.
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function jsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const FILES = jsFiles(SRC).sort();

test('every src module has at least one file to check', () => {
  assert.ok(FILES.length > 5, `expected several modules, found ${FILES.length}`);
});

for (const file of FILES) {
  const rel = relative(SRC, file).replace(/\\/g, '/');
  test(`src/${rel} links: imports resolve to real exports`, async () => {
    // A failure here is a real defect: either a syntax error, or an import of
    // a name the target module does not export.
    await import(pathToFileURL(file).href);
  });
}

/*
 * Guards the reverse direction: a module importing a LOCAL file that does not
 * exist on disk. Node reports this too, but with a path that is easy to
 * misread, so name it explicitly.
 */
test('every relative import points at a file that exists', () => {
  const missing = [];
  for (const file of FILES) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
      const spec = m[1];
      const target = join(file, '..', spec);
      try { readFileSync(target); }
      catch { missing.push(`${relative(SRC, file).replace(/\\/g, '/')} -> ${spec}`); }
    }
  }
  assert.deepEqual(missing, [], `relative imports with no file on disk: ${missing.join(', ')}`);
});
