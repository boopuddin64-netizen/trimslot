/* Haptics + press feedback tests against the local dev server (demo seed). Usage: BASE=http://localhost:4310 node scripts/haptics-ui.mjs
   Checks: vibrate patterns, setting off, unsupported (no throw), rate limit, hidden tab, reduced motion, settings row persists after reload,
   press-scale CSS (and reduced-motion), no overflow at 360/390 in light/dark. Screenshots -> SHOTS (default /workspace/ts-edith-shots). */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:4102', SHOTS = process.env.SHOTS || '/workspace/ts-edith-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let fails = 0, total = 0;
const ok = (c, n, x = '') => { total++; if (!c) { fails++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } else if (process.env.VERBOSE) console.log('PASS ' + n); };
const REC = () => { window.__vib = []; navigator.vibrate = (p) => { window.__vib.push(p); return true; }; };
const mk = async (w, o = {}) => {
  const ctx = await b.newContext({ viewport: { width: w, height: 800 }, isMobile: true, hasTouch: true, baseURL: BASE, reducedMotion: o.reduced ? 'reduce' : 'no-preference', colorScheme: o.dark ? 'dark' : 'light' });
  if (o.dark) await ctx.addInitScript(() => { try { localStorage.setItem('trimslot_theme', 'dark'); } catch {} });
  if (o.rec !== false) await ctx.addInitScript(REC);
  if (o.unsupported) await ctx.addInitScript(() => { try { delete Navigator.prototype.vibrate; } catch {} try { Object.defineProperty(navigator, 'vibrate', { value: undefined, configurable: true }); } catch {} });
  const p = await ctx.newPage(); p.__errs = []; p.on('pageerror', (e) => p.__errs.push(e.message)); return { ctx, p };
};
const login = async (p, id, pw) => { await p.goto('/#/login'); await p.fill('[name=identifier]', id); await p.fill('[name=password]', pw); await p.click('button[type=submit]'); await p.waitForFunction(() => !location.hash.includes('login'), null, { timeout: 8000 }); await p.waitForTimeout(400); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- unit-level, in the real page ---- */
{ const { ctx, p } = await mk(390); await p.goto('/'); await p.waitForFunction(() => window.haptics);
  const r = await p.evaluate(async () => {
    const out = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); const h = window.haptics; localStorage.removeItem('trimslot_haptics');
    out.defaultOn = h.enabled();
    const one = async (n) => { window.__vib.length = 0; h[n](); const v = window.__vib.slice(); await wait(60); return v; };
    out.tick = await one('tick'); out.tap = await one('tap'); out.toggle = await one('toggle'); out.refresh = await one('refresh'); out.success = await one('success'); out.error = await one('error');
    window.__vib.length = 0; h.tap(); h.tap(); h.tick(); out.burst = window.__vib.length; await wait(60); h.tap(); out.afterGap = window.__vib.length;
    h.setEnabled(false); out.offFlag = h.enabled(); window.__vib.length = 0; await wait(60); h.error(); h.success(); out.off = window.__vib.length; out.stored = localStorage.getItem('trimslot_haptics');
    h.setEnabled(true); await wait(60); Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); window.__vib.length = 0; h.error(); out.hidden = window.__vib.length; delete document.hidden;
    return out; });
  ok(r.defaultOn === true, 'haptics default ON');
  ok(r.tick == 8 && r.tap == 12 && r.toggle == 10 && r.refresh == 15, 'simple patterns tick 8 / tap 12 / toggle 10 / refresh 15', JSON.stringify(r));
  ok(JSON.stringify(r.success) === '[[14,40,14]]' && JSON.stringify(r.error) === '[[30,40,30,40,30]]', 'success / error patterns', JSON.stringify([r.success, r.error]));
  ok(r.burst === 1 && r.afterGap === 2, 'rate limit: 3 calls in 40ms = 1 buzz; later call buzzes', `${r.burst}/${r.afterGap}`);
  ok(r.offFlag === false && r.off === 0 && r.stored === '0', 'setting off: no vibrate, saved as 0', JSON.stringify(r));
  ok(r.hidden === 0, 'hidden tab: no vibrate');
  ok(p.__errs.length === 0, 'no page errors', p.__errs.join('|')); await ctx.close(); }
{ const { ctx, p } = await mk(390, { unsupported: true }); await p.goto('/'); await p.waitForFunction(() => window.haptics);
  const r = await p.evaluate(() => { try { const h = window.haptics; const s = typeof navigator.vibrate; ['tap', 'tick', 'success', 'error', 'toggle', 'refresh'].forEach((n) => h[n]()); return { s, threw: false, sup: h.supported() }; } catch (e) { return { threw: String(e) }; } });
  ok(r.threw === false && r.sup === false, 'unsupported browser: all calls are silent no-ops', JSON.stringify(r)); await ctx.close(); }
{ const { ctx, p } = await mk(390, { reduced: true }); await p.goto('/'); await p.waitForFunction(() => window.haptics);
  const r = await p.evaluate(async () => { const h = window.haptics; const w = (ms) => new Promise((r) => setTimeout(r, ms)); const o = {}; window.__vib.length = 0; h.tick(); h.tap(); await w(60); h.toggle(); await w(60); o.small = window.__vib.length; h.error(); o.err = window.__vib.slice(-1)[0]; return o; });
  ok(r.small === 0 && r.err === 20, 'reduced motion: no small buzzes, results are one short pulse', JSON.stringify(r)); await ctx.close(); }

/* ---- settings row: persists, fits, both themes, both roles ---- */
for (const [role, id, pw] of [['customer', 'chidi@trimslot.demo', 'Customer123!'], ['barber', 'mike@trimslot.demo', 'Barber123!']]) {
  for (const w of [360, 390]) for (const dark of [false, true]) {
    const tag = `${role} ${w} ${dark ? 'dark' : 'light'}`;
    const { ctx, p } = await mk(w, { dark }); await login(p, id, pw); await p.goto('/#/profile'); await p.waitForSelector('#hapticsw');
    ok(await p.locator('#hapticsw').getAttribute('aria-checked') === 'true', tag + ' haptics switch starts ON');
    const hint = await p.locator('#hapticsrow .sub').innerText(); ok(/Small buzz when you tap/.test(hint), tag + ' hint in plain words', hint);
    ok(await p.locator('#hapticsrow').count() === 1 && await p.locator('#themesw').count() === 1, tag + ' one haptics row next to dark mode');
    const ov = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth); ok(ov <= 1, tag + ' no horizontal overflow', ov + 'px');
    const rowBox = await p.locator('#hapticsrow').boundingBox(); ok(rowBox && rowBox.x >= 0 && rowBox.x + rowBox.width <= w + 1, tag + ' row inside screen');
    if (role === 'customer' && w === 360) await p.evaluate(() => document.getElementById('hapticsrow').scrollIntoView({ block: 'center' })).then(() => p.screenshot({ path: `${SHOTS}/haptics-settings-${w}-${dark ? 'dark' : 'light'}.png` }));
    await p.evaluate(() => { window.__vib.length = 0; });
    await p.click('#hapticsw'); ok(await p.locator('#hapticsw').getAttribute('aria-checked') === 'false', tag + ' switch turns OFF');
    ok(await p.evaluate(() => localStorage.getItem('trimslot_haptics')) === '0', tag + ' saved in localStorage');
    await p.reload(); await p.waitForSelector('#hapticsw');
    ok(await p.locator('#hapticsw').getAttribute('aria-checked') === 'false', tag + ' still OFF after reload');
    await p.evaluate(() => { window.__vib.length = 0; }); await p.locator('#themesw').click(); await p.waitForTimeout(80);
    ok(await p.evaluate(() => window.__vib.length) === 0, tag + ' no buzz when haptics are OFF (switch tap)');
    await p.click('#hapticsw'); ok(await p.locator('#hapticsw').getAttribute('aria-checked') === 'true', tag + ' switch turns ON again');
    await p.evaluate(() => { window.__vib.length = 0; }); await p.waitForTimeout(80); await p.locator('#themesw').click(); await p.waitForTimeout(80);
    ok(await p.evaluate(() => window.__vib.length) >= 1, tag + ' dark-mode switch buzzes when ON');
    ok(p.__errs.length === 0, tag + ' no page errors', p.__errs.join('|'));
    await ctx.close();
  }
}

/* ---- tab change tick + error toast buzz (customer) ---- */
{ const { ctx, p } = await mk(390); await login(p, 'chidi@trimslot.demo', 'Customer123!'); await p.goto('/#/'); await p.waitForSelector('#tabs a');
  await p.evaluate(() => { window.__vib.length = 0; }); await p.click('#tabs a:not(.on)'); await p.waitForTimeout(100);
  ok(await p.evaluate(() => window.__vib.slice(0, 1)[0]) === 8, 'tab change gives a tick (8ms)');
  await p.waitForTimeout(80); await p.evaluate(() => { window.__vib.length = 0; toast('Test error', true); });
  ok(await p.evaluate(() => JSON.stringify(window.__vib[0])) === '[30,40,30,40,30]', 'error toast gives the error pattern');
  await p.evaluate(() => { window.__vib.length = 0; }); await p.waitForTimeout(80); await p.evaluate(() => toast('Plain message'));
  ok(await p.evaluate(() => window.__vib.length) === 0, 'normal toast does not buzz'); await ctx.close(); }

/* ---- press-scale CSS ---- */
for (const reduced of [false, true]) {
  const { ctx, p } = await mk(390, { reduced }); await login(p, 'chidi@trimslot.demo', 'Customer123!'); await p.goto('/#/profile'); await p.waitForSelector('.lrow');
  const sel = '#tabs a:not(.on)'; const box = await p.locator(sel).first().boundingBox();
  const before = await p.evaluate((s) => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); return [r.width, r.height, getComputedStyle(e).transform]; }, sel);
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down(); await p.waitForTimeout(250);
  const during = await p.evaluate((s) => getComputedStyle(document.querySelector(s)).transform + '|' + getComputedStyle(document.querySelector(s)).opacity, sel);
  const layout = await p.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.width, r.height]; }, sel);
  await p.mouse.up();
  if (!reduced) { ok(/matrix\(0\.97/.test(during), 'press-scale .97 applies on press (tab item)', during); }
  else { ok(during.startsWith('none|') , 'reduced motion: no scale on press', during); }
  ok(before[2] === 'none', 'no transform when idle', before[2]);
  const css = await p.evaluate(() => [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } }).map((r) => r.cssText).join('\n'));
  ok(/:active/.test(css) && /scale\(0?\.97\)/.test(css), 'press-scale rule present in CSS');
  ok(/prefers-reduced-motion[^{]*\{[^]*scale|prefers-reduced-motion/.test(css), 'reduced-motion rule present');
  await ctx.close();
}
await b.close();
console.log(`${total - fails}/${total} haptics checks passed`); process.exit(fails ? 1 : 0);
