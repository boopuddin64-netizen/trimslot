/* Static guards for the public site: strict script-src (no inline scripts or inline event handlers) and no raw error text on screen. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const pub = path.join(root, 'public');
const read = (p: string) => readFileSync(p, 'utf8');
const htmlFiles = readdirSync(pub).filter((f) => f.endsWith('.html')).map((f) => path.join(pub, f));
const jsFiles = readdirSync(pub).filter((f) => f.endsWith('.js') && f !== 'sw.js').map((f) => path.join(pub, f));

test('public CSP does not allow inline scripts (vercel.json and express helmet agree)', () => {
  const vercel = JSON.parse(read(path.join(root, 'vercel.json')));
  const globalCsp = JSON.stringify(vercel.headers).match(/"value":"default-src 'self'; script-src[^"]*"/)?.[0] || '';
  assert.ok(globalCsp, 'global CSP header present');
  assert.doesNotMatch(globalCsp, /script-src[^;]*'unsafe-inline'/);
  const app = read(path.join(root, 'src', 'app.ts'));
  const helmetScript = app.match(/scriptSrc: \[([^\]]*)\]/)?.[1] || '';
  assert.ok(helmetScript.length > 0);
  assert.doesNotMatch(helmetScript, /unsafe-inline/);
});

test('public HTML pages have no inline <script> blocks', () => {
  for (const f of htmlFiles) {
    const inline = [...read(f).matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].filter((m) => m[1].trim());
    assert.equal(inline.length, 0, `${path.basename(f)} has an inline script`);
  }
});

test('public pages and scripts have no inline event-handler attributes', () => {
  for (const f of [...htmlFiles, ...jsFiles]) {
    const hits = read(f).match(/\son(click|error|load|submit|change|input|focus|blur|keydown|mouseover)\s*=\s*["\\']/gi) || [];
    assert.equal(hits.length, 0, `${path.basename(f)} has inline handler(s): ${hits.join(', ')}`);
  }
});

test('no helper call is used as an assignment target (e.g. userMessage(e) = ...)', () => {
  for (const f of jsFiles) {
    const bad = read(f).match(/\b(userMessage|userError)\([^)]*\)\s*=(?!=)/g) || [];
    assert.equal(bad.length, 0, `${path.basename(f)} assigns to a function call: ${bad.join(', ')}`);
  }
});

test('the error helper exists on every page that shows errors', () => {
  for (const f of htmlFiles) {
    const s = read(f);
    if (s.includes('theme.js')) assert.ok(s.includes('/errmsg.js'), `${path.basename(f)} loads errmsg.js`);
  }
});

test('no API error text is shown raw: pages use userMessage(), not e.message', () => {
  for (const f of jsFiles.filter((f) => !f.endsWith('errmsg.js'))) {
    const bad = read(f).match(/\b(e|e2|er|er2|err|ex|x)\.message\b(?! ?(\|\||===|!==|\?|=(?!=)))/g) || [];
    const shown = bad.filter((m) => m !== 'x.message');
    assert.equal(shown.length, 0, `${path.basename(f)} shows raw error text: ${shown.join(', ')}`);
  }
});
