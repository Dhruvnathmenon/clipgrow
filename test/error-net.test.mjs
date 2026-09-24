// components/error-net.js turns a silently broken page into a visible message.
// Run against a small fake browser, so what it reports (and what it stays quiet
// about) is pinned without a real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../components/error-net.js', import.meta.url), 'utf8');
const APP_PAGES = ['admin.html', 'dashboard.html', 'moderator.html', 'client-dashboard.html', 'login.html', 'client-login.html', 'tracker.html'];

function fakeBrowser() {
  const listeners = {};
  const made = [];
  const el = () => {
    const e = { style: {}, children: [], attrs: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); if (this.children.length === 1) this.firstChild = c; } };
    made.push(e); return e;
  };
  const body = el();
  const document = { body, documentElement: body, getElementById: id => made.find(e => e.id === id) || null, createElement: () => el() };
  const window = { addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); } };
  vm.runInNewContext(SOURCE, { window, document, location: { origin: 'https://clipgrow.in' } });
  const banner = () => made.find(e => e.id === 'cg-error-net');
  const text = () => (banner() && banner().style.display === 'block' ? banner().firstChild.textContent : null);
  return { window, fire: (type, ev) => (listeners[type] || []).forEach(fn => fn(ev)), text, banner, listeners };
}

test('a script error on the page shows a banner with the reason and what to do', () => {
  const b = fakeBrowser();
  assert.equal(b.text(), null, 'nothing shown while the page is healthy');
  b.fire('error', { message: 'Uncaught SyntaxError: Invalid or unexpected token', filename: 'https://clipgrow.in/admin', target: b.window });
  assert.match(b.text(), /Something on this page broke/);
  assert.match(b.text(), /Invalid or unexpected token/);
  assert.match(b.text(), /Refresh the page/);
  assert.equal(b.banner().attrs.role, 'alert', 'announced to screen readers');
});

test('an unhandled failed request shows what failed', () => {
  const b = fakeBrowser();
  b.fire('unhandledrejection', { reason: new Error('Internal server error') });
  assert.match(b.text(), /That did not work: Internal server error/);
});

test('one of our own scripts failing to load is reported; a broken image is not', () => {
  let b = fakeBrowser();
  b.fire('error', { target: { tagName: 'SCRIPT', src: 'https://clipgrow.in/components/clipper-applications.js?v=5' }, message: '' });
  assert.match(b.text(), /did not load/);
  b = fakeBrowser();
  b.fire('error', { target: { tagName: 'IMG', src: 'https://clipgrow.in/x.png' }, message: '' });
  assert.equal(b.text(), null);
});

// Cloudflare injects its analytics beacon into every page; ad blockers and privacy
// extensions block it. That fired the "did not load" banner permanently for anyone
// with a blocker, over a script the page does not depend on.
test('a blocked third-party script (the Cloudflare analytics beacon) never shows a banner', () => {
  const b = fakeBrowser();
  b.fire('error', { target: { tagName: 'SCRIPT', src: 'https://static.cloudflareinsights.com/beacon.min.js/v31edd6df95cf4e85bb4c19e7a9bdbcba1788362987495' }, message: '' });
  b.fire('error', { target: { tagName: 'SCRIPT', src: 'https://www.googletagmanager.com/gtag/js?id=x' }, message: '' });
  b.fire('error', { target: { tagName: 'SCRIPT', src: 'https://clipgrow.in.evil.example/x.js' }, message: '' });
  b.fire('error', { target: { tagName: 'SCRIPT' }, message: '' });
  assert.equal(b.text(), null);
});

test('noise that is not the page\'s fault stays quiet', () => {
  const b = fakeBrowser();
  b.fire('error', { message: 'Script error.', filename: '', target: b.window });
  b.fire('error', { message: 'ResizeObserver loop completed with undelivered notifications.', filename: 'https://clipgrow.in/x', target: b.window });
  b.fire('error', { message: 'boom', filename: 'chrome-extension://abc/content.js', target: b.window });
  b.fire('error', { message: 'boom', filename: 'https://other.example/x.js', target: b.window });
  b.fire('unhandledrejection', { reason: { name: 'AbortError', message: 'The user aborted a request.' } });
  b.fire('unhandledrejection', { reason: undefined });
  b.fire('unhandledrejection', { reason: null });
  const ext = new Error('extension thing'); ext.stack = 'Error\n at chrome-extension://abc/x.js:1:1';
  b.fire('unhandledrejection', { reason: ext });
  assert.equal(b.text(), null);
});

test('it never throws, whatever it is handed', () => {
  const b = fakeBrowser();
  for (const ev of [{}, { target: null }, { message: null, target: b.window }, { message: 5, target: b.window }, { message: 'x'.repeat(10000), target: b.window }]) assert.doesNotThrow(() => b.fire('error', ev));
  for (const ev of [{}, { reason: 5 }, { reason: 'plain string' }, { reason: { message: 5 } }, { reason: { stack: 1 } }]) assert.doesNotThrow(() => b.fire('unhandledrejection', ev));
  assert.ok(b.text().length < 400, 'long messages are cut, not dumped onto the page');
});

test('the same message repeating does not stack or flicker', () => {
  const b = fakeBrowser();
  for (let i = 0; i < 50; i++) b.fire('unhandledrejection', { reason: new Error('down') });
  assert.equal(b.banner().children.length, 2, 'one message and one close button, however many times it fires');
});

for (const page of APP_PAGES) {
  test(`${page} loads the safety net before its own script`, () => {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    const net = html.indexOf('/components/error-net.js');
    assert.ok(net > -1, `${page} does not load components/error-net.js`);
    const firstInline = html.search(/<script(?![^>]*\bsrc=)[^>]*>/i);
    assert.ok(firstInline === -1 || net < firstInline, `${page} loads it after an inline script, so an early error would go unreported`);
  });
}
