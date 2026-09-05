// submitReview is the only write path onto submission_reviews. Three things
// have to hold: a verdict is one of the three real ones, feedback is never
// optional (a moderator has to say why, even for Skip), and a submission can
// only ever be reviewed once. None of this may ever touch submissions'
// earning/lock/payment columns -- see this file's own header comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteD1 } from './helpers/sqlite-d1.mjs';
import { submitReview, clipperQuality } from '../src/reviews.js';

const NOW = Date.now();

function seedEnv() {
  return makeSqliteD1({
    clippers: [{ id: 1, username: 'clipper1', password_hash: 'h', password_salt: 's',
                 status: 'active', created_at: NOW }],
    campaigns: [{ id: 1, name: 'Test Campaign', description: '', cpm: 40, budget: 10000,
                  status: 'active', created_at: NOW, model: 'cpm', min_views: 1000,
                  allowed_platforms: 'instagram' }],
    submissions: [{ id: 1, clipper_id: 1, campaign_id: 1, ig_media_id: 'm1', permalink: 'https://instagram.com/p/1',
                    views: 100, earning: 500, created_at: NOW, platform: 'instagram', source: 'manual', status: 'active' }]
  });
}

test('rejects an unrecognised verdict', async () => {
  const db = seedEnv();
  const r = await submitReview(db, {
    submissionId: 1, verdict: 'maybe', feedback: 'looks fine',
    reviewerType: 'admin', reviewerId: null, reviewerName: 'Admin'
  });
  assert.equal(r.status, 400);
  assert.match(r.error, /not a valid verdict/);
});

for (const verdict of ['tick', 'cross', 'skip']) {
  test(`feedback is required for ${verdict}, not just tick/cross`, async () => {
    const db = seedEnv();
    const r = await submitReview(db, {
      submissionId: 1, verdict, feedback: '   ',
      reviewerType: 'admin', reviewerId: null, reviewerName: 'Admin'
    });
    assert.equal(r.status, 400);
    assert.match(r.error, /Feedback is required/);
  });
}

test('a submission can only be reviewed once', async () => {
  const db = seedEnv();
  const first = await submitReview(db, {
    submissionId: 1, verdict: 'tick', feedback: 'good',
    reviewerType: 'admin', reviewerId: null, reviewerName: 'Admin'
  });
  assert.ok(first.id);
  const second = await submitReview(db, {
    submissionId: 1, verdict: 'cross', feedback: 'actually no',
    reviewerType: 'admin', reviewerId: null, reviewerName: 'Admin'
  });
  assert.equal(second.status, 409);
});

test('a real review never touches earning or lock state', async () => {
  const db = seedEnv();
  await submitReview(db, {
    submissionId: 1, verdict: 'cross', feedback: 'needs better lighting',
    reviewerType: 'admin', reviewerId: null, reviewerName: 'Admin'
  });
  const sub = await db.prepare('SELECT earning, locked_at, locked_earning, payment_id FROM submissions WHERE id = ?')
    .bind(1).first();
  assert.equal(sub.earning, 500);
  assert.equal(sub.locked_at, null);
  assert.equal(sub.locked_earning, null);
  assert.equal(sub.payment_id, null);
});

test('quality percentage excludes skip from the ratio, and is null with zero reviews', async () => {
  const db = seedEnv();
  assert.equal((await clipperQuality(db, 1)).quality_pct, null);
  await submitReview(db, { submissionId: 1, verdict: 'skip', feedback: 'already verified on YouTube',
    reviewerType: 'admin', reviewerId: null, reviewerName: 'Admin' });
  // Still null: one skip, zero tick+cross, so the denominator is zero.
  assert.equal((await clipperQuality(db, 1)).quality_pct, null);
});
