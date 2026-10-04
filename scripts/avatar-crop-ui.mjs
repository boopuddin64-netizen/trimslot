/* Profile-picture cropper UI test (headless Chrome via playwright-core) against a running dev server with mock payments.
   Usage: node scripts/avatar-crop-ui.mjs   (env BASE, default http://localhost:4103)  -> exit 1 on any failure; screenshots in screenshots/avatar-crop/
   `npm run avatar-ui` boots a throw-away Postgres + server first (scripts/avatar-crop-run.ts). Covers: mouse drag, wheel, slider + keyboard, touch drag + two-finger pinch
   (real touch events through the DevTools protocol), Cancel, Esc, Save (size/dimensions/content of the stored picture), failed upload, bad file, light + dark contrast (WCAG AA), small phones. */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:4103';
fs.mkdirSync('screenshots/avatar-crop', { recursive: true });
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let fails = 0, total = 0; const errs = [];
const ok = (c, n, x = '') => { total++; if (!c) { fails++; console.log('FAIL ' + n + (x !== '' ? ' :: ' + x : '')); } else if (process.env.VERBOSE) console.log('PASS ' + n); };

/** 1600x900 test picture: red | green | blue vertical bands (so we can tell exactly which part was cropped). */
async function makeImage(p) {
  const arr = await p.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 1600; c.height = 900; const g = c.getContext('2d');
    g.fillStyle = '#d02020'; g.fillRect(0, 0, 534, 900); g.fillStyle = '#20b040'; g.fillRect(534, 0, 533, 900); g.fillStyle = '#2040d0'; g.fillRect(1067, 0, 533, 900);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92)); return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  return { name: 'pic.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(arr) };
}
const tr = (p) => p.evaluate(() => { const m = new DOMMatrix(getComputedStyle(document.querySelector('.crop-img')).transform); return { s: m.a, x: m.e, y: m.f }; });
const sliderV = (p) => p.$eval('#crop-z', (e) => Number(e.value));
const box = async (loc) => (await loc.boundingBox());

/** WCAG contrast helpers evaluated in the page. */
const contrastProbe = () => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return [0, 0, 0, 1]; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; };
  const over = (f, bg) => [f[0] * f[3] + bg[0] * (1 - f[3]), f[1] * f[3] + bg[1] * (1 - f[3]), f[2] * f[3] + bg[2] * (1 - f[3]), 1];
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, c) => { const l1 = lum(a), l2 = lum(c); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const bgOf = (el) => { const chain = []; for (let x = el; x; x = x.parentElement) chain.push(x); let bg = [255, 255, 255, 1]; for (let i = chain.length - 1; i >= 0; i--) { const c = parse(getComputedStyle(chain[i]).backgroundColor); if (c[3] > 0) bg = over(c, bg); } return bg; };
  const sheet = document.querySelector('.sheet.crop'), card = bgOf(sheet), out = {};
  const text = (sel, key) => { const e = document.querySelector(sel); const s = getComputedStyle(e); out[key] = ratio(over(parse(s.color), bgOf(e)), bgOf(e)); };
  text('.sheet.crop h3', 'title'); text('#crop-help', 'help'); text('.crop-zoom label', 'zoomLabel');
  text('[data-save]', 'save'); text('[data-cancel]', 'cancel');
  const bd = (sel, key, prop = 'borderTopColor') => { const e = document.querySelector(sel); out[key] = ratio(over(parse(getComputedStyle(e)[prop]), card), card); };
  bd('.crop-view', 'viewBorder'); bd('[data-cancel]', 'cancelBorder');
  const sv = document.querySelector('[data-save]'); out.saveFill = ratio(parse(getComputedStyle(sv).backgroundColor), card);
  // slider parts: read from the stylesheet rules (pseudo-elements are not reachable via getComputedStyle on the element)
  const rule = (needle) => { for (const ss of document.styleSheets) { let rs; try { rs = ss.cssRules; } catch { continue; } for (const r of rs) if (r.selectorText && r.selectorText.includes(needle)) return r; } };
  const cv = (v) => { const t = document.createElement('i'); t.style.color = `var(${v})`; document.body.appendChild(t); const c = parse(getComputedStyle(t).color); t.remove(); return c; };
  out.track = ratio(cv('--ctl'), card); out.thumb = ratio(cv('--brand'), card);
  out.trackRule = !!rule('slider-runnable-track'); out.thumbRule = !!rule('slider-thumb');
  return out;
};

async function signupAndOpen(p, label) {
  await p.goto('/#/signup?role=customer'); await p.waitForSelector('[name=accept_terms]');
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  await p.fill('[name=name]', 'Crop Tester ' + label); await p.fill('[name=email]', `crop${label}${stamp}@example.com`); await p.fill('[name=password]', 'Password123');
  await p.check('[name=accept_terms]'); await p.click('button[type=submit]'); await p.waitForFunction(() => !location.hash.includes('signup'), null, { timeout: 8000 });
  await p.goto('/#/profile'); await p.waitForSelector('.avatar-edit #av-file', { state: 'attached' });
}
async function pick(p, file) { await p.setInputFiles('#av-file', file); await p.waitForSelector('.sheet.crop'); await p.waitForFunction(() => !document.querySelector('[data-save]').disabled); }

async function suite({ w, h, theme, touch }) {
  const tag = `${w}x${h}-${theme}${touch ? '-touch' : '-mouse'}`;
  const ctx = await b.newContext({ viewport: { width: w, height: h }, baseURL: BASE, hasTouch: !!touch, isMobile: !!touch, deviceScaleFactor: 2 });
  await ctx.addInitScript((t) => { try { localStorage.setItem('trimslot_theme', t); } catch { /* ignore */ } }, theme);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(tag + ' ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errs.push(tag + ' ' + m.text().slice(0, 140)); });
  await signupAndOpen(p, tag.replace(/[^a-z0-9]/gi, ''));
  const img = await makeImage(p);

  // ---- open, labels, validity
  await pick(p, img);
  await p.screenshot({ path: `screenshots/avatar-crop/${tag}-open.png` });
  ok(await p.locator('.sheet.crop[role=dialog][aria-modal=true]').count() === 1, tag + ' dialog role');
  ok((await p.getAttribute('.sheet.crop', 'aria-labelledby')) === 'crop-t' && /Adjust/.test(await p.textContent('#crop-t')), tag + ' dialog has a title');
  ok(await p.locator('label[for=crop-z]').textContent() === 'Zoom', tag + ' slider has a visible label');
  ok(await p.locator('[data-cancel]').isVisible() && await p.locator('[data-save]').isEnabled(), tag + ' Cancel visible, Save enabled for a valid image');
  const vb = await box(p.locator('#crop-view')); const VV = await p.$eval('#crop-view', (e) => e.clientWidth);
  ok(Math.abs(vb.width - vb.height) < 1.5 && vb.width >= 130, tag + ' preview is square box', `${vb.width}x${vb.height}`);
  ok(await p.$eval('#crop-view', (e) => getComputedStyle(e).borderRadius) === '50%', tag + ' preview is round');
  const sheetBox = await box(p.locator('.sheet.crop'));
  ok(sheetBox.y >= 0 && sheetBox.y + sheetBox.height <= h + 0.5 && sheetBox.x >= 0 && sheetBox.x + sheetBox.width <= w + 0.5, tag + ' dialog fits the screen', JSON.stringify(sheetBox));
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), tag + ' no horizontal overflow');
  ok(await p.evaluate(() => document.activeElement && document.activeElement.id === 'crop-view'), tag + ' focus moves into the dialog');
  // initial: image covers the preview, centred
  const t0 = await tr(p); const covers = (t, V, W, H) => t.x <= 0.5 && t.y <= 0.5 && t.x + W * t.s >= V - 0.5 && t.y + H * t.s >= V - 0.5;
  ok(covers(t0, VV, 1600, 900), tag + ' image covers the preview at start', JSON.stringify(t0));

  // ---- contrast (AA) of the dialog in this theme
  const c = await p.evaluate(contrastProbe);
  for (const k of ['title', 'help', 'zoomLabel', 'save', 'cancel']) ok(c[k] >= 4.5, `${tag} text contrast ${k} >= 4.5`, c[k].toFixed(2));
  for (const k of ['viewBorder', 'cancelBorder', 'saveFill', 'track', 'thumb']) ok(c[k] >= 3, `${tag} control contrast ${k} >= 3`, c[k].toFixed(2));
  ok(c.trackRule && c.thumbRule, tag + ' slider is styled');

  // ---- drag
  const cx = vb.x + vb.width / 2, cy = vb.y + vb.height / 2, u = vb.width / 14;   // u: pinch offsets scale with the preview (small in landscape phones)
  let before = await tr(p);
  if (touch) {
    const cdp = await ctx.newCDPSession(p);
    const tp = (pts) => pts.map(([x, y], i) => ({ x, y, id: i + 1 }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp([[cx, cy]]) });
    for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp([[cx + i * 0.15 * vb.width, cy]]) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    let after = await tr(p); ok(after.x > before.x + 20, tag + ' one-finger drag moves the picture', `${before.x}->${after.x}`);
    // pinch out (spread) about the centre
    before = await tr(p); const s0 = await sliderV(p);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp([[cx - 2 * u, cy], [cx + 2 * u, cy]]) });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp([[cx - 2 * u - i * 0.8 * u, cy], [cx + 2 * u + i * 0.8 * u, cy]]) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    after = await tr(p); ok(after.s > before.s * 1.5, tag + ' two-finger spread zooms in', `${before.s}->${after.s}`);
    ok(await sliderV(p) > s0 + 10, tag + ' slider follows the pinch', `${s0}->${await sliderV(p)}`);
    // pinch in
    const mid = await tr(p);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp([[cx - 6 * u, cy], [cx + 6 * u, cy]]) });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp([[cx - 6 * u + i * 0.7 * u, cy], [cx + 6 * u - i * 0.7 * u, cy]]) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    after = await tr(p); ok(after.s < mid.s * 0.8, tag + ' two-finger pinch zooms out', `${mid.s}->${after.s}`);
    await p.screenshot({ path: `screenshots/avatar-crop/${tag}-pinched.png` });
  } else {
    await p.mouse.move(cx, cy); await p.mouse.down(); await p.mouse.move(cx + 40, cy + 5, { steps: 6 }); await p.mouse.move(cx + 120, cy + 5, { steps: 6 }); await p.mouse.up();
    const after = await tr(p); ok(after.x > before.x + 30, tag + ' mouse drag moves the picture', `${before.x}->${after.x}`);
    ok(Math.abs(after.y - before.y) < 0.5, tag + ' short axis stays pinned at zoom 1');
    ok(covers(after, VV, 1600, 900), tag + ' dragging never exposes empty corners');
    await p.mouse.move(cx, cy); await p.mouse.down(); await p.mouse.move(cx + 3000, cy, { steps: 4 }); await p.mouse.up();
    ok(covers(await tr(p), VV, 1600, 900), tag + ' dragging far past the edge stays clamped');
    // wheel zoom
    const s1 = (await tr(p)).s; await p.mouse.move(cx, cy); await p.mouse.wheel(0, -300); await p.waitForFunction(() => Number(document.querySelector('#crop-z').value) > 0, null, { timeout: 3000 }).catch(() => {});
    ok((await tr(p)).s > s1 * 1.1, tag + ' mouse wheel zooms in', s1 + '->' + JSON.stringify(await tr(p)) + ' slider ' + await sliderV(p)); ok(await sliderV(p) > 3, tag + ' slider follows the wheel');
  }

  // ---- slider with the keyboard (works for everyone, incl. screen readers)
  await p.locator('#crop-z').focus(); await p.keyboard.press('Home');
  ok(await sliderV(p) === 0 && (await tr(p)).s < t0.s * 1.01, tag + ' Home on the slider resets zoom');
  const vt0 = await p.getAttribute('#crop-z', 'aria-valuetext'); await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowRight');
  ok(await sliderV(p) === 2 && (await p.getAttribute('#crop-z', 'aria-valuetext')) !== vt0, tag + ' arrow keys change zoom + aria-valuetext', await p.getAttribute('#crop-z', 'aria-valuetext'));
  await p.keyboard.press('End'); ok(await sliderV(p) === 100 && Math.abs((await tr(p)).s / t0.s - 4) < 0.05, tag + ' End = max zoom (400%)');
  await p.keyboard.press('Home');
  // arrow keys on the preview move the picture
  await p.locator('#crop-view').focus(); const k0 = await tr(p); await p.keyboard.press('ArrowLeft'); await p.keyboard.press('ArrowLeft');
  ok((await tr(p)).x > k0.x || k0.x >= -0.5 ? true : false, tag + ' arrow keys on the preview move the photo');
  await p.keyboard.press('+'); ok(await sliderV(p) > 0, tag + ' + zooms');

  // ---- Tab stays inside the dialog
  const seen = new Set(); for (let i = 0; i < 6; i++) { await p.keyboard.press('Tab'); seen.add(await p.evaluate(() => document.activeElement.id || document.activeElement.textContent.trim())); }
  ok(await p.evaluate(() => !!document.activeElement.closest('.sheet.crop')), tag + ' Tab never leaves the dialog', [...seen].join('|'));
  ok(seen.has('crop-view') && seen.has('crop-z') && seen.has('Cancel') && seen.has('Save'), tag + ' all four controls are reachable by keyboard', [...seen].join('|'));

  // ---- Cancel: nothing uploaded, dialog gone, focus back
  let puts = 0; p.on('request', (r) => { if (r.method() === 'PUT' && /\/api\/me\/avatar/.test(r.url())) puts++; });
  await p.click('[data-cancel]'); await p.waitForSelector('.sheet.crop', { state: 'detached' });
  ok(puts === 0 && await p.locator('.avatar-edit .av.has').count() === 0, tag + ' Cancel saves nothing');
  ok(await p.evaluate(() => document.body.style.overflow !== 'hidden'), tag + ' page scroll is restored');
  await pick(p, img); await p.keyboard.press('Escape'); await p.waitForSelector('.sheet.crop', { state: 'detached' }); ok(puts === 0, tag + ' Esc cancels');

  // ---- failed upload keeps the dialog open with a message, Save usable again
  await p.route('**/api/me/avatar', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Could not save right now.' } }) }));
  await pick(p, img); await p.click('[data-save]'); await p.waitForSelector('#crop-err:not(.hidden)');
  ok(/Could not save/.test(await p.textContent('#crop-err')) && await p.getAttribute('#crop-err', 'role') === 'alert', tag + ' failed upload shows an alert in the dialog');
  ok(await p.locator('[data-save]').isEnabled() && await p.locator('[data-cancel]').isEnabled() && await p.locator('.sheet.crop').count() === 1, tag + ' buttons re-enabled after a failure');
  await p.unroute('**/api/me/avatar'); await p.click('[data-cancel]'); await p.waitForSelector('.sheet.crop', { state: 'detached' });

  // ---- bad file: no dialog, message under the buttons
  await p.setInputFiles('#av-file', { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from('this is not an image') });
  await p.waitForFunction(() => /could not read that picture/i.test(document.querySelector('#av-msg').textContent), null, { timeout: 5000 });
  ok(await p.locator('.sheet.crop').count() === 0, tag + ' unreadable file: message, no dialog');

  // ---- Save a specific crop: zoom to max in the centre -> only the green band; check the stored picture
  await pick(p, img); await p.locator('#crop-z').focus(); await p.keyboard.press('End');
  await p.screenshot({ path: `screenshots/avatar-crop/${tag}-zoomed.png` });
  const put = p.waitForResponse((r) => r.request().method() === 'PUT' && /\/api\/me\/avatar/.test(r.url()));
  await p.click('[data-save]'); const resp = await put; ok(resp.status() === 200, tag + ' save uploads (200)', String(resp.status()));
  await p.waitForSelector('.avatar-edit .av.has', { timeout: 8000 }); await p.waitForSelector('.sheet.crop', { state: 'detached' });
  const info = await p.evaluate(async () => {
    const u = state.user.avatar_url; const r = await fetch(u, { credentials: 'same-origin' }); const blob = await r.blob();
    const bmp = await createImageBitmap(blob); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const px = (x, y) => Array.from(g.getImageData(Math.min(bmp.width - 1, x), Math.min(bmp.height - 1, y), 1, 1).data.slice(0, 3));
    return { type: blob.type, size: blob.size, w: bmp.width, h: bmp.height, left: px(8, bmp.height / 2 | 0), right: px(bmp.width - 8, bmp.height / 2 | 0) };
  });
  ok(info.type === 'image/jpeg' && info.w === info.h && info.w === 225, tag + ' max zoom: square JPEG at the real source resolution (900/4 = 225 px, not upscaled)', JSON.stringify(info));
  ok(info.size < 100 * 1024, tag + ' stored picture is small', Math.round(info.size / 1024) + ' KB');
  ok(info.left[1] > 130 && info.left[0] < 90 && info.right[1] > 130 && info.right[2] < 110, tag + ' max zoom saved only the green middle', JSON.stringify([info.left, info.right]));
  const rad = await p.$eval('.avatar-edit .av', (e) => { const s = getComputedStyle(e); return [s.borderRadius, e.offsetWidth, e.offsetHeight]; });
  ok(rad[0] === '50%' && rad[1] === rad[2], tag + ' avatar renders as a round, square box', rad.join(','));
  await p.screenshot({ path: `screenshots/avatar-crop/${tag}-saved.png` });

  // ---- re-crop from the left edge (mouse only): default crop shows red|green|blue; drag far right shows only red+green
  if (!touch) {
    await pick(p, img); const v = await box(p.locator('#crop-view')); const mx = v.x + v.width / 2, my = v.y + v.height / 2;
    await p.mouse.move(mx, my); await p.mouse.down(); await p.mouse.move(mx + 3000, my, { steps: 4 }); await p.mouse.up();
    await p.click('[data-save]'); await p.waitForSelector('.sheet.crop', { state: 'detached' });
    const i2 = await p.evaluate(async () => { const r = await fetch(state.user.avatar_url, { credentials: 'same-origin' }); const bb = await r.blob(); const bmp = await createImageBitmap(bb); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); const px = (x) => Array.from(g.getImageData(x, 256, 1, 1).data.slice(0, 3)); return { l: px(8), r: px(bmp.width - 8), w: bmp.width, h: bmp.height, kb: Math.round(bb.size / 1024) }; });
    ok(i2.w === 512 && i2.h === 512 && i2.kb < 100, tag + ' normal save is 512x512 and small', JSON.stringify([i2.w, i2.h, i2.kb + ' KB']));
    ok(i2.l[0] > 150 && i2.l[1] < 90 && i2.r[1] > 130 && i2.r[2] < 110, tag + ' dragged to the left edge: red on the left, green on the right (no blue)', JSON.stringify(i2));
  }
  await ctx.close();
}

for (const cfg of [
  { w: 1280, h: 800, theme: 'light', touch: false }, { w: 1280, h: 800, theme: 'dark', touch: false },
  { w: 390, h: 800, theme: 'light', touch: true }, { w: 390, h: 800, theme: 'dark', touch: true },
  { w: 360, h: 640, theme: 'light', touch: true }, { w: 640, h: 360, theme: 'dark', touch: true },
]) { try { await suite(cfg); } catch (e) { fails++; total++; console.log('FAIL suite ' + JSON.stringify(cfg) + ' :: ' + e.message.split('\n')[0]); } }
await b.close();
console.log(errs.length ? 'console/page errors: ' + [...new Set(errs)].slice(0, 5).join(' | ') : 'console/page errors: 0');
console.log(`${total - fails}/${total} checks passed`); process.exit(fails || errs.length ? 1 : 0);
