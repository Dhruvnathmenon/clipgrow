/*
 * Makes a broken page say so.
 *
 * One syntax error anywhere in a page's script stops ALL of it from running, and
 * the page then looks fine while every button does nothing -- which is exactly how
 * the admin login was unclickable for a day with no message anywhere. A promise
 * that rejects with no .catch does the same thing more quietly: a list stays on
 * "Loading..." forever.
 *
 * This file is deliberately tiny, dependency-free and separate from each page's own
 * script, so whatever breaks in the page cannot also break the thing that reports it.
 * It shows a red banner at the top of the page with what went wrong and what to do.
 */
(function () {
  'use strict';
  var lastShown = '';

  function banner(text) {
    // The same message repeating (a failing timer, say) must not stack or flicker.
    if (text === lastShown) return;
    lastShown = text;
    try {
      var el = document.getElementById('cg-error-net');
      if (!el) {
        el = document.createElement('div');
        el.id = 'cg-error-net';
        el.setAttribute('role', 'alert');
        el.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;background:#8a1c1c;color:#fff;' +
          'font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;padding:10px 46px 10px 16px;box-shadow:0 2px 12px rgba(0,0,0,.4)';
        var msg = document.createElement('span');
        var close = document.createElement('button');
        close.type = 'button';
        close.setAttribute('aria-label', 'Dismiss this message');
        close.textContent = '×';
        close.style.cssText = 'position:absolute;right:8px;top:2px;background:none;border:0;color:#fff;font-size:24px;line-height:1;cursor:pointer;padding:6px 10px';
        close.onclick = function () { el.style.display = 'none'; lastShown = ''; };
        el.appendChild(msg);
        el.appendChild(close);
        (document.body || document.documentElement).appendChild(el);
      }
      el.firstChild.textContent = text;
      el.style.display = 'block';
    } catch (e) { /* nothing more can be done, and this must never throw */ }
  }

  function ours(filename) {
    // A script from an extension or another site is not ours to report on.
    return !filename || filename.indexOf(location.origin) === 0;
  }

  // capture = true so a script or stylesheet that failed to LOAD is seen too
  window.addEventListener('error', function (ev) {
    var t = ev.target;
    if (t && t !== window) {
      if (t.tagName === 'SCRIPT') banner('Part of this page did not load, so some buttons may not work. Refresh the page; if it keeps happening, tell the ClipGrow admin.');
      return; // a broken image or font is not worth a banner
    }
    var m = String(ev.message || '');
    if (!m || m === 'Script error.' || /ResizeObserver loop/i.test(m) || !ours(ev.filename)) return;
    banner('Something on this page broke, so some buttons may not work. Refresh the page; if it keeps happening, tell the ClipGrow admin. (' + m.slice(0, 140) + ')');
  }, true);

  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    var m = r && r.message ? String(r.message) : (typeof r === 'string' ? r : '');
    if (!m || /AbortError|aborted|ResizeObserver/i.test(m)) return;
    if (r && r.stack && /-extension:/.test(String(r.stack))) return;
    banner('That did not work: ' + m.slice(0, 160) + '. Try again; if it keeps happening, tell the ClipGrow admin.');
  });
})();
