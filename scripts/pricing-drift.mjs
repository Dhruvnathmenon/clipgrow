#!/usr/bin/env node
// Is every clip priced the way the allocator would price it RIGHT NOW?
//
//   node scripts/pricing-drift.mjs            # production, every open campaign
//   node scripts/pricing-drift.mjs 905        # one campaign
//   node scripts/pricing-drift.mjs --local    # the local wrangler database instead
//
// READ-ONLY. It copies each campaign's rows into an in-memory database, runs the
// real allocator (src/earnings.js) on the copy, and reports what would change. It
// never writes to the database it reads from. Repairing is the job of the hourly
// run (or the admin's Refresh button): if this report shows drift that stays for
// more than one refresh, something is wrong, and that is the point of running it.
//
// Why it exists: on 24 Sep 2026 the hourly refresh was cut off part-way for 13 runs
// in a row, so nothing was re-priced and a clip with 10,000+ views sat at Rs 0. The
// only sign was a number on one clipper's screen. This would have shown it in
// minutes, across every campaign, before anyone asked.
//
// Exit code: 0 when nothing is behind, 1 when some clip is priced differently from
// what the allocator says now (a Rs 1 wobble from views moving since the last pass
// is normal and not counted; see TOLERANCE).
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const remote = !process.argv.includes('--local');
const only = process.argv.slice(2).find(a => /^\d+$/.test(a));
// A clip whose stored price is within this many rupees of the fresh one is not
// "behind": views move between passes. Anything bigger, or any clip stuck at Rs 0
// that should be earning, is reported.
const TOLERANCE = 2;

const { makeSqliteD1 } = await import(pathToFileURL(join(ROOT, 'test/helpers/sqlite-d1.mjs')).href);
const { allocateCampaignEarnings } = await import(pathToFileURL(join(ROOT, 'src/earnings.js')).href);

function query(sql) {
  let last = '';
  for (let i = 0; i < 5; i++) {
    try {
      const out = execFileSync(process.execPath,
        [join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'clipgrow', remote ? '--remote' : '--local', '--json', '--command', sql],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      return JSON.parse(out.slice(out.indexOf('[')))[0].results;
    } catch (e) {
      last = String((e.stdout || '') + (e.stderr || '') || e.message).slice(0, 300);
      if (/SQLITE_ERROR/.test(last)) break;
      // wrangler's connection to Cloudflare is flaky from some networks; a retry is the fix
    }
  }
  throw new Error('query failed: ' + last);
}

const campaigns = query(`SELECT * FROM campaigns WHERE status != 'completed'${only ? ` AND id = ${Number(only)}` : ''} ORDER BY id`);
if (!campaigns.length) { console.log('No open campaigns to check.'); process.exit(0); }

let behind = 0;
console.log(`Checking ${campaigns.length} campaign(s) in ${remote ? 'PRODUCTION' : 'the local database'} (read-only)\n`);
for (const camp of campaigns) {
  const subs = query(`SELECT * FROM submissions WHERE campaign_id = ${camp.id} ORDER BY id`);
  const parts = query(`SELECT * FROM participations WHERE campaign_id = ${camp.id}`);

  const db = makeSqliteD1({});
  db._sqlite.exec('PRAGMA foreign_keys = OFF');            // a copy of ONE campaign: its parents are not needed
  const put = (table, rows) => {
    for (const r of rows) {
      const cols = Object.keys(r);
      db._sqlite.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => r[c]));
    }
  };
  put('campaigns', [camp]); put('submissions', subs); put('participations', parts);

  const stored = new Map(subs.map(s => [s.id, s]));
  await allocateCampaignEarnings(db, camp.id);
  const fresh = db._sqlite.prepare('SELECT id, views, earning, locked_at FROM submissions WHERE campaign_id = ?').all(camp.id);
  const freshStatus = db._sqlite.prepare('SELECT status FROM campaigns WHERE id = ?').get(camp.id).status;

  const off = [];
  for (const f of fresh) {
    if (f.locked_at) continue;                              // paid and closed clips are history: never re-priced
    const was = stored.get(f.id).earning || 0;
    const diff = f.earning - was;
    if (Math.abs(diff) > TOLERANCE || (was === 0 && f.earning > 0)) off.push({ id: f.id, views: f.views, stored: was, fresh: f.earning, diff });
  }
  const net = off.reduce((n, o) => n + o.diff, 0);
  const ok = off.length === 0 && freshStatus === camp.status;
  if (!ok) behind++;

  console.log(`${ok ? 'OK    ' : 'BEHIND'} #${camp.id} ${camp.name}  [${camp.status}]  ${subs.length} clips` +
    (ok ? '' : `  -> ${off.length} clip(s) priced differently (net ${net >= 0 ? '+' : ''}${net})` +
      (freshStatus !== camp.status ? `; status should be ${freshStatus}` : '')));
  for (const o of off.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 8)) {
    console.log(`         clip ${o.id}: ${o.views.toLocaleString('en-IN')} views, stored Rs ${o.stored}, should be Rs ${o.fresh} (${o.diff >= 0 ? '+' : ''}${o.diff})`);
  }
  if (off.length > 8) console.log(`         ... and ${off.length - 8} more`);
}

console.log(behind ? `\n${behind} campaign(s) behind. One refresh should clear it; if it is still here after the next hourly run, look at the Error Log (JOB_ABANDONED / REPRICE_FAILED).`
                    : '\nEvery open campaign is priced exactly as the allocator would price it now.');
process.exit(behind ? 1 : 0);
