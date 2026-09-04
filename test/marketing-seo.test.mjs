import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SEO_ROUTES, renderSeoBlock, renderJsonLd } from '../src/seo-content.js';

/*
 * src/seo-content.js carries a hand-copy of the two marketing FAQs so the
 * Worker can server-render FAQPage schema for /for-clippers and /for-brands
 * without importing the SPA's TypeScript. FAQPage schema whose answers do not
 * match the answers a visitor can actually read is the mismatch Google
 * penalises, so the copy in the two places must stay identical.
 *
 * The SPA (premium-mock/) is gitignored and not always checked out; when it is
 * absent this drift check is skipped rather than failed.
 */

const SITE_TS = fileURLToPath(
  new URL('../premium-mock/src/data/site.ts', import.meta.url)
);

test('marketing FAQ copy has not drifted from the SPA source', { skip: !existsSync(SITE_TS) && 'premium-mock/ not checked out' }, () => {
  const src = readFileSync(SITE_TS, 'utf8');
  for (const path of ['/for-clippers', '/for-brands']) {
    for (const { q, a } of SEO_ROUTES[path].faq) {
      assert.ok(src.includes(q), `question missing from site.ts (${path}): ${q}`);
      assert.ok(src.includes(a), `answer missing from site.ts (${path}): ${q}`);
    }
  }
});

test('every marketing route renders a single keyword <h1> and closes its tags', () => {
  for (const [path, cfg] of Object.entries(SEO_ROUTES)) {
    const block = renderSeoBlock(cfg);
    const h1s = block.match(/<h1>/g) || [];
    assert.equal(h1s.length, 1, `${path}: expected exactly one <h1>`);
    assert.ok(block.includes(`<h1>`) && block.includes('</h1>'), `${path}: <h1> not closed`);
    assert.equal((block.match(/<div /g) || []).length, (block.match(/<\/div>/g) || []).length, `${path}: unbalanced <div>`);
    assert.ok(/india/i.test(cfg.h1) || path === '/for-clippers', `${path}: h1 should be geo-qualified`);
    // The block must never carry an executable <script> — only the JSON-LD,
    // which lives in <head>, is allowed to.
    assert.ok(!/<script(?![^>]*application\/ld\+json)/i.test(block), `${path}: unexpected <script> in body block`);
  }
});

test('JSON-LD for every route is valid and typed', () => {
  for (const [path, cfg] of Object.entries(SEO_ROUTES)) {
    const html = renderJsonLd(cfg);
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.ok(blocks.length >= 1, `${path}: no JSON-LD emitted`);
    for (const [, json] of blocks) {
      const obj = JSON.parse(json);
      assert.equal(obj['@context'], 'https://schema.org', `${path}: bad @context`);
      assert.ok(obj['@type'], `${path}: JSON-LD block has no @type`);
    }
    if (cfg.faq) {
      assert.ok(html.includes('"FAQPage"'), `${path}: has faq but no FAQPage schema`);
      const faqBlock = blocks.map(b => JSON.parse(b[1])).find(o => o['@type'] === 'FAQPage');
      assert.equal(faqBlock.mainEntity.length, cfg.faq.length, `${path}: FAQPage question count mismatch`);
    }
  }
});

test('titles and descriptions mirror the SPA Seo.tsx where it is checked out', () => {
  const seoTsx = fileURLToPath(new URL('../premium-mock/src/components/Seo.tsx', import.meta.url));
  if (!existsSync(seoTsx)) return;
  const src = readFileSync(seoTsx, 'utf8');
  for (const [path, cfg] of Object.entries(SEO_ROUTES)) {
    // Seo.tsx wraps long strings; compare on a whitespace-collapsed needle.
    const needle = cfg.title.replace(/\s+/g, ' ').trim();
    assert.ok(src.replace(/\s+/g, ' ').includes(needle), `${path}: title not found in Seo.tsx`);
  }
});
