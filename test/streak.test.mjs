// Consistency streaks for the public leaderboard.
//
// The correctness point that matters most here: a streak MUST be measured from
// when a clip went live on the platform, not when ClipGrow imported it. Import
// runs on a six-hourly cron and has backed up for days in production (observed
// lag: 911 hours), so one import pass can land a week of uploads at a single
// instant. Measured on import time, a clipper posting every single day reads as
// a broken streak, and a backlog flush collapses several days into one. This is
// a public board, so getting that wrong misrepresents people's work to peers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipperStreak, allClipperStreaks } from '../src/db.js';

const DAY = 86400000;
const IST = 5.5 * 60 * 60 * 1000;

// A timestamp landing safely inside the IST day `n` days back, avoiding
// boundary flakiness regardless of when the suite runs.
function daysAgoIST(n) {
  const todayIstDay = Math.floor((Date.now() + IST) / DAY);
  return ((todayIstDay - n) * DAY) - IST + (12 * 3600000);
}

function makeDb(rows) {
  return {
    prepare(sql) {
      const st = {
        bind: () => st,
        all: async () => {
          if (/FROM submissions s\s+JOIN clippers cl/.test(sql)) {
            return { results: rows.map(r => ({ clipper_id: r.clipper_id, ts: r.posted_at ?? r.created_at })) };
          }
          return { results: rows.map(r => ({ ts: r.posted_at ?? r.created_at })) };
        }
      };
      return st;
    }
  };
}

test('streak: posting on each of the last 3 days gives a streak of 3', async () => {
  const db = makeDb([
    { clipper_id: 1, posted_at: daysAgoIST(0) },
    { clipper_id: 1, posted_at: daysAgoIST(1) },
    { clipper_id: 1, posted_at: daysAgoIST(2) }
  ]);
  const s = await clipperStreak(db, 1);
  assert.equal(s.current, 3);
  assert.equal(s.days_since_last_post, 0);
});

test('streak: a backlog import of 3 days of posts still counts as 3 days, not 1', async () => {
  // All three imported at the same instant (a single catch-up run), but posted
  // on three separate days. Keyed on created_at this would collapse to 1.
  const importedAt = Date.now();
  const db = makeDb([
    { clipper_id: 1, posted_at: daysAgoIST(0), created_at: importedAt },
    { clipper_id: 1, posted_at: daysAgoIST(1), created_at: importedAt },
    { clipper_id: 1, posted_at: daysAgoIST(2), created_at: importedAt }
  ]);
  const s = await clipperStreak(db, 1);
  assert.equal(s.current, 3, 'posting dates drive the streak, not the import batch');
});

test('streak: daily posting whose imports lagged days still reads as unbroken', async () => {
  // Posted every day; every import landed 3 days late in one lump.
  const late = Date.now();
  const db = makeDb([0, 1, 2, 3, 4].map(n => ({ clipper_id: 1, posted_at: daysAgoIST(n), created_at: late })));
  const s = await clipperStreak(db, 1);
  assert.equal(s.current, 5, 'import lag must never cost a clipper their streak');
});

test('streak: yesterday still counts as alive, two days ago does not', async () => {
  const alive = await clipperStreak(makeDb([{ clipper_id: 1, posted_at: daysAgoIST(1) }]), 1);
  assert.equal(alive.current, 1, 'not having posted YET today has not broken anything');
  assert.equal(alive.days_since_last_post, 1);

  const lapsed = await clipperStreak(makeDb([{ clipper_id: 1, posted_at: daysAgoIST(2) }]), 1);
  assert.equal(lapsed.current, 0, 'a full missed day lapses the streak');
  assert.equal(lapsed.days_since_last_post, 2);
});

test('streak: several posts on one day count as one day, not several', async () => {
  const db = makeDb([
    { clipper_id: 1, posted_at: daysAgoIST(0) },
    { clipper_id: 1, posted_at: daysAgoIST(0) + 3600000 },
    { clipper_id: 1, posted_at: daysAgoIST(0) + 7200000 }
  ]);
  const s = await clipperStreak(db, 1);
  assert.equal(s.current, 1, 'consistency is per day, not per upload');
});

test('streak: best is retained after a current streak lapses', async () => {
  // A 4-day run that ended a while ago, plus a single recent post.
  const db = makeDb([
    { clipper_id: 1, posted_at: daysAgoIST(0) },
    { clipper_id: 1, posted_at: daysAgoIST(10) },
    { clipper_id: 1, posted_at: daysAgoIST(11) },
    { clipper_id: 1, posted_at: daysAgoIST(12) },
    { clipper_id: 1, posted_at: daysAgoIST(13) }
  ]);
  const s = await clipperStreak(db, 1);
  assert.equal(s.current, 1);
  assert.equal(s.best, 4, 'a personal best survives a lapse');
});

test('streak: a clipper with no posts reports zero rather than crashing', async () => {
  const s = await clipperStreak(makeDb([]), 1);
  assert.deepEqual(s, { current: 0, best: 0, last_post_at: null, days_since_last_post: null });
});

test('allClipperStreaks: computes every clipper independently in one pass', async () => {
  const db = makeDb([
    { clipper_id: 1, posted_at: daysAgoIST(0) },
    { clipper_id: 1, posted_at: daysAgoIST(1) },
    { clipper_id: 2, posted_at: daysAgoIST(5) },
    { clipper_id: 3, posted_at: daysAgoIST(0) },
    { clipper_id: 3, posted_at: daysAgoIST(1) },
    { clipper_id: 3, posted_at: daysAgoIST(2) }
  ]);
  const all = await allClipperStreaks(db);
  assert.equal(all.get(1).current, 2);
  assert.equal(all.get(2).current, 0, 'lapsed');
  assert.equal(all.get(2).days_since_last_post, 5);
  assert.equal(all.get(3).current, 3);
});
