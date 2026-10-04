/* Profile-photo picking test (headless Chrome via playwright-core) against a running dev server. Reproduces the iPhone bug: production sends a Content-Security-Policy
   whose img-src lacked blob:, so the old cropper (which showed the file through a blob: URL) said "We could not read that picture" for EVERY photo.
   Every response here gets the exact CSP from vercel.json. Covers: JPEG, PNG, large 4000x3000 JPEG, EXIF-rotated JPEG, a file with an empty type, an HEIC-typed file that decodes,
   an HEIC that cannot be decoded (simple message, no dialog), a PDF, a CSP without blob:, no createImageBitmap, neither -> each walks choose, crop, zoom, save and checks the round avatar.
   Usage: BASE=http://localhost:4103 node scripts/avatar-photos-ui.mjs  (npm run avatar-ui boots the server and runs this after avatar-crop-ui.mjs) */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:4103';
const PROD_CSP = JSON.parse(fs.readFileSync('vercel.json', 'utf8')).headers.flatMap((h) => h.headers).find((h) => h.key === 'Content-Security-Policy').value;
const OLD_CSP = PROD_CSP.replace(' blob:', '');
fs.mkdirSync('screenshots/avatar-photos', { recursive: true });
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let fails = 0, total = 0;
const ok = (c, n, x = '') => { total++; if (!c) { fails++; console.log('FAIL ' + n + (x !== '' ? ' :: ' + x : '')); } else if (process.env.VERBOSE) console.log('PASS ' + n); };
ok(/img-src[^;]*blob:/.test(PROD_CSP), 'vercel.json CSP allows blob: images');

/** Build a JPEG/PNG in the page. Returns bytes. */
const make = (p, o) => p.evaluate(async (o) => {
  const c = document.createElement('canvas'); c.width = o.w; c.height = o.h; const g = c.getContext('2d');
  g.fillStyle = '#d02020'; g.fillRect(0, 0, o.w / 3, o.h); g.fillStyle = '#20b040'; g.fillRect(o.w / 3, 0, o.w / 3, o.h); g.fillStyle = '#2040d0'; g.fillRect((2 * o.w) / 3, 0, o.w / 3, o.h);
  const blob = await new Promise((r) => c.toBlob(r, o.type, 0.9)); return Array.from(new Uint8Array(await blob.arrayBuffer()));
}, o);
/** Insert an EXIF APP1 segment with Orientation = 6 (rotate 90 degrees clockwise) right after the JPEG start marker. */
function withOrientation6(jpeg) {
  const exif = Buffer.from([0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
  const len = exif.length + 2; return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1, len >> 8, len & 255]), exif, jpeg.subarray(2)]);
}

/** The home screen may still be loading after sign-up and would paint over the profile: try again until the photo section stays. */
async function toProfile(p) {
  for (let i = 0; i < 4; i++) {
    await p.waitForTimeout(800); await p.goto('/#/' + (i % 2 ? 'home' : 'profile')); await p.goto('/#/profile');
    try { await p.waitForSelector('#av-file', { state: 'attached', timeout: 4000 }); await p.waitForTimeout(600); if (await p.locator('#av-file').count()) return; } catch { /* retry */ }
  }
  throw new Error('profile screen did not show the photo section');
}
let saved = null;   // one sign-up per run (the server allows 10 sign-ups per 15 minutes from one network); every later browser context reuses this login
async function session({ csp, noBitmap, expectCspNoise, w = 390, h = 800 }) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, baseURL: BASE, hasTouch: true, isMobile: true, deviceScaleFactor: 2, serviceWorkers: 'block', ...(saved ? { storageState: saved } : {}) });   // no service worker: it would answer before the test's header rewrite
  await ctx.addInitScript(() => { if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.reject(new Error('service worker off in this test')); });   // Playwright's own block resolves with undefined, a browser rejects
  if (noBitmap) await ctx.addInitScript(() => { delete window.createImageBitmap; });
  const p = await ctx.newPage(); const errs = [], warns = [];
  await p.route('**/*', async (route) => {   // same response, but with the CSP header from vercel.json (the local server sends its own)
    try {
      const r = await route.fetch(); const body = await r.body();   // read the body first: a response must not be disposed before it is used
      const h = { ...r.headers(), 'content-security-policy': csp }; delete h['content-encoding']; delete h['content-length']; delete h['transfer-encoding'];   // body() is already decoded
      await route.fulfill({ status: r.status(), headers: h, body });
    } catch (e) { await route.continue().catch(() => {}); }   // e.g. the page was closed while the request was in flight
  });
  p.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && !(expectCspNoise && /Content Security Policy/.test(m.text()))) errs.push(m.text().slice(0, 200)); if (m.type() === 'warning') warns.push(m.text().slice(0, 200)); });
  p.on('pageerror', (e) => errs.push(e.message));
  if (!saved) {
    await p.goto('/#/signup?role=customer'); await p.waitForSelector('[name=accept_terms]', { timeout: 15000 });
    await p.fill('[name=name]', 'Photo Tester'); await p.fill('[name=email]', `photo${process.pid}${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`); await p.fill('[name=password]', 'Password123');
    await p.check('[name=accept_terms]'); await p.click('button[type=submit]');
    await p.waitForFunction(() => !location.hash.includes('signup') && !!document.querySelector('#tabs:not(.hidden), .mybarber, #nobarbers'), null, { timeout: 20000 });
    saved = await ctx.storageState();
  }
  await toProfile(p);
  return { ctx, p, errs, warns };
}

/** choose -> crop -> zoom -> save -> round avatar shows. */
async function walk(s, tag, file, expect = {}) {
  const { p } = s;
  ok((await p.getAttribute('#av-file', 'accept')) === 'image/*' && (await p.getAttribute('#av-cam', 'accept')) === 'image/*', tag + ' file inputs accept image/*');
  await p.setInputFiles('#av-file', file);
  await p.waitForSelector('.sheet.crop', { timeout: 8000 });
  await p.waitForFunction(() => !document.querySelector('[data-save]').disabled);
  const dims = await p.$eval('.crop-img', (e) => ({ w: e.width, h: e.height, tag: e.tagName }));
  ok(Math.max(dims.w, dims.h) <= 1600, tag + ' picture is shrunk to <= 1600 px', JSON.stringify(dims));
  if (expect.maxDims) ok(dims.w === expect.maxDims[0] && dims.h === expect.maxDims[1], tag + ' size after shrink', JSON.stringify(dims));
  if (expect.portrait) ok(dims.h > dims.w, tag + ' EXIF rotation applied (portrait)', JSON.stringify(dims));
  await p.screenshot({ path: `screenshots/avatar-photos/${tag.replace(/\W+/g, '-')}.png` });
  await p.$eval('#crop-z', (e) => { e.value = '50'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  ok(Number(await p.$eval('#crop-z', (e) => e.getAttribute('aria-valuetext').replace('%', ''))) >= 200, tag + ' zoom works');
  await p.click('[data-save]');
  await p.waitForSelector('.sheet.crop', { state: 'detached', timeout: 10000 });
  await p.waitForSelector('.avatar-edit .av.has', { timeout: 8000 });
  const info = await p.evaluate(async () => {
    const el = document.querySelector('.avatar-edit .av.has'); const radius = getComputedStyle(el).borderRadius, box = el.getBoundingClientRect().width;   // measured before anything can re-render
    const url = /url\("?([^")]+)"?\)/.exec(el.style.backgroundImage)[1];
    const r = await fetch(url, { credentials: 'same-origin' }); const bl = await r.blob();
    const dataUrl = await new Promise((res) => { const f = new FileReader(); f.onload = () => res(f.result); f.readAsDataURL(bl); });   // data: works under every CSP here
    const bmp = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res({ width: im.naturalWidth, height: im.naturalHeight }); im.onerror = rej; im.src = dataUrl; });
    return { radius, status: r.status, type: bl.type, size: bl.size, w: bmp.width, h: bmp.height, box };
  });
  ok(info.status === 200 && info.type === 'image/jpeg' && info.size <= 100 * 1024 && info.w === info.h, tag + ' saved picture is a small square JPEG', JSON.stringify(info));
  ok(info.radius === '50%' || parseFloat(info.radius) >= info.box / 2 - 1, tag + ' avatar is round', JSON.stringify(info));
  ok(s.errs.length === 0, tag + ' no console errors (CSP violations etc.)', s.errs.join(' | '));
}

const small = async (p, type) => ({ name: type === 'image/png' ? 'a.png' : 'a.jpg', mimeType: type, buffer: Buffer.from(await make(p, { w: 900, h: 600, type })) });
const cases = [
  { tag: 'prod CSP', csp: PROD_CSP },
  { tag: 'old CSP (no blob:)', csp: OLD_CSP },
  { tag: 'old CSP, no createImageBitmap (data: path)', csp: OLD_CSP, noBitmap: true, expectCspNoise: true },   // the blob: try is refused (logged by the browser), then the data: try works
  { tag: 'prod CSP, no createImageBitmap (blob: path)', csp: PROD_CSP, noBitmap: true },
];
for (const c of cases) {
  const s = await session(c);
  try {
    const t = (x) => `${c.tag} / ${x}`;
    await walk(s, t('JPEG'), await small(s.p, 'image/jpeg'));
    await toProfile(s.p);
    await walk(s, t('PNG'), await small(s.p, 'image/png'));
    if (c.tag === 'prod CSP') {
      const big = Buffer.from(await make(s.p, { w: 4000, h: 3000, type: 'image/jpeg' }));
      await walk(s, t('large 4000x3000 JPEG'), { name: 'big.jpg', mimeType: 'image/jpeg', buffer: big }, { maxDims: [1600, 1200] });
      const rot = withOrientation6(Buffer.from(await make(s.p, { w: 900, h: 400, type: 'image/jpeg' })));
      await walk(s, t('EXIF-rotated JPEG'), { name: 'rot.jpg', mimeType: 'image/jpeg', buffer: rot }, { portrait: true });
      const j = Buffer.from(await make(s.p, { w: 900, h: 600, type: 'image/jpeg' }));
      await walk(s, t('empty file type (iOS Choose)'), { name: 'IMG_1.JPG', mimeType: '', buffer: j });
      await walk(s, t('HEIC-typed file that decodes'), { name: 'IMG_2.HEIC', mimeType: 'image/heic', buffer: j });
      // an HEIC the browser cannot read: simple message, no dialog, reason in console.warn
      await s.p.setInputFiles('#av-file', { name: 'IMG_3.HEIC', mimeType: 'image/heic', buffer: Buffer.from('not really a picture, just bytes '.repeat(50)) });
      await s.p.waitForFunction(() => /format we cannot open/.test(document.querySelector('#av-msg').textContent), null, { timeout: 8000 });
      ok(await s.p.locator('.sheet.crop').count() === 0, 'undecodable HEIC: no dialog');
      ok(!/Try a JPEG or PNG/.test(await s.p.textContent('#av-msg')), 'undecodable HEIC: message in simple words');
      ok(s.warns.some((w) => /could not read the picture/.test(w)), 'undecodable HEIC: reason logged with console.warn', s.warns.join(' | '));
      await s.p.setInputFiles('#av-file', { name: 'x.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
      await s.p.waitForFunction(() => /Please choose a picture/.test(document.querySelector('#av-msg').textContent), null, { timeout: 5000 });
      ok(true, 'PDF refused politely');
      s.errs.length = 0;
    }
  } catch (e) { fails++; total++; console.log('FAIL case ' + c.tag + ' :: ' + String(e.message).split('\n')[0]); }
  await s.ctx.close();
}
// small phone too
{
  const s = await session({ csp: PROD_CSP, w: 360, h: 640 });
  try { await walk(s, '360x640 prod CSP / JPEG', await small(s.p, 'image/jpeg')); } catch (e) { fails++; total++; console.log('FAIL 360 :: ' + String(e.message).split('\n')[0]); }
  await s.ctx.close();
}
await b.close();
console.log(`${total - fails}/${total} photo checks passed`); process.exit(fails ? 1 : 0);
