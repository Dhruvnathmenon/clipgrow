import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/*
 * Guards against the exact regression that broke every refresh button in
 * production: a refactor deleted a function definition and left its call sites
 * behind. Nothing caught it -- these pages have no build step and no module
 * system, so a missing function is only a ReferenceError at the moment a user
 * clicks it, and the surrounding try/catch turned that into a misleading red
 * toast ("renderClipsBudget is not defined") that read like a server fault.
 *
 * Three functions had been deleted this way (renderClipsBudget, showJobStarting,
 * showJobError) across two files before a user reported it.
 *
 * Stripping is done with a real tokenizer rather than regexes: these files
 * contain nested template literals and regex literals holding quote characters
 * (/[&<>"']/g), both of which defeat the regex approach and produce false
 * positives from prose inside comments.
 */

const PAGES = ['dashboard.html', 'admin.html', 'client-dashboard.html', 'tracker.html'];

const GLOBALS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'new', 'do',
  'else', 'delete', 'void', 'in', 'of', 'instanceof', 'yield', 'throw', 'case', 'async',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date', 'Promise', 'Set', 'Map',
  'RegExp', 'Error', 'TypeError', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'Symbol', 'BigInt',
  'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI',
  'decodeURI', 'structuredClone', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout',
  'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask', 'alert',
  'confirm', 'prompt', 'URLSearchParams', 'URL', 'FormData', 'Blob', 'File', 'FileReader', 'Image',
  'Audio', 'Event', 'CustomEvent', 'IntersectionObserver', 'MutationObserver', 'ResizeObserver',
  'AbortController', 'Notification', 'WebSocket', 'Worker', 'getComputedStyle', 'matchMedia',
  'scrollTo', 'atob', 'btoa', 'reportError', 'escape', 'unescape'
]);

/**
 * Replaces every comment, string, template literal and regex literal with
 * equivalent-length blanks, so what remains is only executable code. Template
 * substitutions (`${...}`) are kept as code, since real calls live in them.
 */
function stripNonCode(src) {
  const out = src.split('');
  const blank = (from, to) => { for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '; };
  // Stack lets a `${}` inside a template return to template mode afterwards.
  const stack = [];
  let i = 0, mode = 'code', start = 0, prev = '';

  const regexAllowed = () => !/[\w$)\]]$/.test(prev.trimEnd());

  while (i < src.length) {
    const c = src[i], c2 = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && c2 === '/') { mode = 'line'; start = i; i += 2; continue; }
      if (c === '/' && c2 === '*') { mode = 'block'; start = i; i += 2; continue; }
      if (c === '/' && regexAllowed()) { mode = 'regex'; start = i; i++; continue; }
      if (c === "'" || c === '"') { mode = 'str'; stack.push(c); start = i; i++; continue; }
      if (c === '`') { mode = 'tpl'; start = i; i++; continue; }
      if (c === '}' && stack.length && stack[stack.length - 1] === '${') {
        stack.pop(); mode = 'tpl'; start = i + 1; i++; continue;
      }
      if (!/\s/.test(c)) prev += c;
      if (prev.length > 12) prev = prev.slice(-12);
      i++; continue;
    }
    if (mode === 'line') { if (c === '\n') { blank(start, i); mode = 'code'; } i++; continue; }
    if (mode === 'block') {
      if (c === '*' && c2 === '/') { blank(start, i + 2); mode = 'code'; i += 2; continue; }
      i++; continue;
    }
    if (mode === 'str') {
      if (c === '\\') { i += 2; continue; }
      if (c === stack[stack.length - 1]) { stack.pop(); blank(start, i + 1); mode = 'code'; prev = '""'; }
      i++; continue;
    }
    if (mode === 'regex') {
      if (c === '\\') { i += 2; continue; }
      if (c === '[') { // char class: / and quotes inside are literal
        while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; }
        i++; continue;
      }
      if (c === '/') { blank(start, i + 1); mode = 'code'; prev = 'RE'; i++; continue; }
      if (c === '\n') { mode = 'code'; i++; continue; }   // not a regex after all
      i++; continue;
    }
    if (mode === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '$' && c2 === '{') { blank(start, i); stack.push('${'); mode = 'code'; prev = '('; i += 2; continue; }
      if (c === '`') { blank(start, i + 1); mode = 'code'; prev = '""'; i++; continue; }
      i++; continue;
    }
  }
  if (mode !== 'code') blank(start, src.length);
  return out.join('');
}

function definedNames(src) {
  const names = new Set();
  const add = (re, g = 1) => { for (const m of src.matchAll(re)) names.add(m[g]); };
  add(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g);
  add(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g);
  add(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g);
  add(/\b([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?function\b/g);
  add(/\bclass\s+([A-Za-z_$][\w$]*)/g);
  // function params, so callbacks are not read as undefined functions
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const p of m[1].split(',')) {
      const n = p.trim().replace(/[.]{3}/, '').split(/[=:\s]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
    }
  }
  for (const m of src.matchAll(/\bfunction\s*[\w$]*\s*\(([^()]*)\)/g)) {
    for (const p of m[1].split(',')) {
      const n = p.trim().replace(/[.]{3}/, '').split(/[=:\s]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
    }
  }
  return names;
}

for (const page of PAGES) {
  test(`${page}: every function called is also defined`, () => {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
      .map(m => m[1]).join('\n');
    assert.ok(scripts.length > 0, `${page} has no inline script to check`);

    // Inline on* handlers live inside template strings, which stripping blanks
    // out -- collect them from the raw source. These matter most: nothing in
    // the code references them, so a rename breaks them silently.
    const handlerCalls = new Set();
    for (const m of scripts.matchAll(/\bon(?:click|change|input|submit|keydown|keyup)\s*=\s*\\?["']([^"'\\]+)/gi)) {
      for (const c of m[1].matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) handlerCalls.add(c[2]);
    }

    const defined = definedNames(scripts);
    const missing = new Map();
    const record = (name, where) => {
      if (GLOBALS.has(name) || defined.has(name)) return;
      if (!missing.has(name)) missing.set(name, new Set());
      missing.get(name).add(where);
    };

    for (const m of stripNonCode(scripts).matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) record(m[2], 'code');
    for (const name of handlerCalls) record(name, 'inline handler');

    assert.deepEqual(
      [...missing.keys()].sort(), [],
      `${page} calls function(s) that are never defined: ` +
      [...missing.entries()].map(([n, w]) => `${n}() [${[...w].join(', ')}]`).join(', ')
    );
  });
}
