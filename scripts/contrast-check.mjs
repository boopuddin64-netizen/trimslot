/* WCAG AA contrast audit in BOTH themes (computed styles, real rendering) for customer, barber and admin screens.
   Text >= 4.5:1 (3:1 for large text), disabled text >= 3:1, placeholders >= 4.5:1, stars / icons >= 3:1,
   control boundaries (inputs, outlined buttons, chips, switches) >= 3:1 against their surroundings (or a filled control against its surroundings).
   Usage: node scripts/contrast-check.mjs   (env BASE, ADMINKEY, WIDTHS=360,390, THEMES=light,dark, VERBOSE=1)  -> exit 1 on any failure. */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:4102', ADMINKEY = process.env.ADMINKEY || 'local-admin-key-xyz';
const WIDTHS = (process.env.WIDTHS || '390').split(',').map(Number), THEMES = (process.env.THEMES || 'light,dark').split(',');
const CUST = (process.env.CUST || 'chidi@trimslot.demo:Customer123!').split(':'), BARB = (process.env.BARB || 'mike@trimslot.demo:Barber123!').split(':');
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const fails = new Map(); let pages = 0, checks = 0;

/* runs inside the page */
function scan() {
  const parse = (c) => { // -> [r,g,b,a] 0-255 / 0-1
    if (!c || c === 'transparent') return [0, 0, 0, 0];
    let m = c.match(/^rgba?\(([^)]+)\)$/); if (m) { const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
    m = c.match(/^color\(srgb ([^)]+)\)$/); if (m) { const p = m[1].split(/[ \/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1]; }
    return [0, 0, 0, 1];
  };
  const over = (f, bg) => { const a = f[3]; return [f[0] * a + bg[0] * (1 - a), f[1] * a + bg[1] * (1 - a), f[2] * a + bg[2] * (1 - a), 1]; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, c) => { const l1 = lum(a), l2 = lum(c); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const pageBg = () => over(parse(getComputedStyle(document.body).backgroundColor), over(parse(getComputedStyle(document.documentElement).backgroundColor), [255, 255, 255, 1]));
  const bgOf = (el, includeSelf = true) => { // composite background layers from root to el
    const chain = []; for (let x = includeSelf ? el : el.parentElement; x; x = x.parentElement) chain.push(x);
    let bg = pageBg(); for (let i = chain.length - 1; i >= 0; i--) { const c = parse(getComputedStyle(chain[i]).backgroundColor); if (c[3] > 0) bg = over(c, bg); } return bg;
  };
  const opacityOf = (el) => { let o = 1; for (let x = el; x; x = x.parentElement) o *= parseFloat(getComputedStyle(x).opacity); return o; };
  const visible = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); if (r.width < 2 || r.height < 2 || s.visibility === 'hidden' || s.display === 'none') return false;
    for (let x = el; x && x !== document.body; x = x.parentElement) { const st = getComputedStyle(x); if (st.display === 'none' || st.visibility === 'hidden') return false; if (x.tagName === 'DETAILS' && !x.open && !el.closest('summary')) return false; if (x.classList.contains('hidden')) return false; } return true; };
  const label = (el) => (el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '') + ' "' + (el.textContent || el.getAttribute('aria-label') || el.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 24) + '"');
  const out = [];
  const add = (kind, el, fg, bg, need) => { const r = ratio(fg, bg); out.push({ kind, el: label(el), ratio: Math.round(r * 100) / 100, need, ok: r >= need - 0.001 }); };
  const disabledEl = (el) => !!(el.closest('[disabled],[aria-disabled=true],.is-invalid') || el.disabled);
  // 1) text
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n; (n = walker.nextNode());) {
    if (!n.nodeValue.trim()) continue; const el = n.parentElement; if (!el || seen.has(el) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].includes(el.tagName) || !visible(el)) continue; seen.add(el);
    if (el.closest('.mockbar,#mockbanner')) { /* dev-only banner still checked */ }
    const s = getComputedStyle(el); const bg = bgOf(el); let fg = parse(s.color); fg[3] *= opacityOf(el); fg = over(fg, bg);
    const size = parseFloat(s.fontSize), bold = parseInt(s.fontWeight, 10) >= 700, large = size >= 24 || (size >= 18.66 && bold);
    add(disabledEl(el) ? 'disabled-text' : 'text', el, fg, bg, disabledEl(el) ? 3 : (large ? 3 : 4.5));
  }
  // 2) input values + placeholders + select text
  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),textarea,select')) {
    if (!visible(el)) continue; const bg = bgOf(el); const s = getComputedStyle(el);
    if (el.placeholder) { const p = getComputedStyle(el, '::placeholder'); let fg = parse(p.color); fg[3] *= parseFloat(p.opacity || 1); add('placeholder', el, over(fg, bg), bg, 4.5); }
    if (el.value || el.tagName === 'SELECT') add(el.disabled ? 'disabled-text' : 'input-text', el, over(parse(s.color), bg), bg, el.disabled ? 3 : 4.5);
  }
  // 3) icons / stars (svg uses currentColor / fill / stroke)
  for (const svg of document.querySelectorAll('svg')) {
    if (!visible(svg) || svg.closest('button:disabled,[disabled]')) continue; const s = getComputedStyle(svg); const paint = (s.fill && s.fill !== 'none') ? s.fill : (s.stroke && s.stroke !== 'none' ? s.stroke : null); if (!paint) continue;
    const el = svg.closest('i,button,a,span') || svg; const bg = bgOf(svg.parentElement || svg); let fg = parse(paint); fg[3] *= opacityOf(svg); const isStar = !!svg.closest('.stars,.starpick');
    add(isStar ? 'star' : 'icon', isStar ? svg.parentElement : svg.parentElement || svg, over(fg, bg), bg, 3);
  }
  // 4) control boundaries: outlined or filled controls must separate from their surroundings by >= 3:1
  const ctl = document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),textarea,select,button.btn,a.btn,.chip,.svc,.switch,.seg,.seg button.on');
  for (const el of ctl) {
    if (!visible(el)) continue; const s = getComputedStyle(el); const around = bgOf(el, false); const own = over(parse(s.backgroundColor), around);
    const bw = parseFloat(s.borderTopWidth) || 0; const bc = bw > 0 ? over(parse(s.borderTopColor), around) : null;
    const best = Math.max(bc ? ratio(bc, around) : 0, ratio(own, around));
    if (el.disabled || el.classList.contains('is-invalid')) continue;
    // a filled control only needs its fill OR border; text-only buttons (no border, same bg) are skipped
    if (!bc && ratio(own, around) < 1.05) continue;
    out.push({ kind: 'control-boundary', el: label(el), ratio: Math.round(best * 100) / 100, need: 3, ok: best >= 3 - 0.001 });
  }
  return out;
}

async function newPage(w, theme) {
  const ctx = await b.newContext({ viewport: { width: w, height: 844 }, isMobile: w < 800, hasTouch: w < 800, baseURL: BASE, colorScheme: theme });
  await ctx.addInitScript((t) => { try { localStorage.setItem('trimslot_theme', t); } catch { /* */ } }, theme);
  const p = await ctx.newPage(); return { ctx, p };
}
async function setTheme(p, theme) { await p.evaluate((t) => { if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark'); else document.documentElement.removeAttribute('data-theme'); try { localStorage.setItem('trimslot_theme', t); } catch { /* */ } }, theme); await p.waitForTimeout(150); }
async function check(p, name, w, theme) {
  await setTheme(p, theme); const res = await p.evaluate(scan); pages++;
  const dir = `/workspace/trimslot/screenshots/contrast/${theme}-${w}/`; fs.mkdirSync(dir, { recursive: true }); await p.screenshot({ path: dir + name.replace(/[^a-z0-9]+/gi, '_') + '.png', fullPage: true }).catch(() => {});
  for (const r of res) { checks++; if (!r.ok) { const k = `${theme} ${w} | ${r.kind} | ${r.el}`; const f = fails.get(k) || { ratio: r.ratio, need: r.need, pages: [] }; f.pages.push(name); fails.set(k, f); } }
}
async function login(p, id, pw) { await p.goto('/#/login'); await p.fill('[name=identifier]', id); await p.fill('[name=password]', pw); await p.click('button[type=submit]'); await p.waitForFunction(() => !location.hash.includes('login'), null, { timeout: 8000 }); await p.waitForTimeout(500); }
const api = async (p, path) => p.evaluate(async (u) => (await fetch('/api' + u)).json(), path);

for (const theme of THEMES) for (const w of WIDTHS) {
  { const { ctx, p } = await newPage(w, theme); for (const r of ['#/', '#/login', '#/signup?role=barber', '#/signup?role=customer']) { await p.goto('/' + r); await p.waitForTimeout(500); await check(p, 'public ' + r, w, theme); } await ctx.close(); }
  { const { ctx, p } = await newPage(w, theme); await login(p, CUST[0], CUST[1]);
    const bks = (await api(p, '/bookings')).bookings || []; const byStatus = {}; for (const k of bks) byStatus[k.status] ??= k.id;
    const pages = ['#/', '#/barber/1', '#/book/1', '#/bookings', '#/wallet', '#/profile', '#/notifications', ...Object.entries(byStatus).map(([s, id]) => `#/booking/${id}`)];
    for (const r of pages) { await p.goto('/' + r); await p.waitForTimeout(700); await check(p, 'customer ' + r, w, theme); }
    // wizard: service selected, slot selected, form states
    await p.goto('/#/book/1'); await p.waitForSelector('.svc'); await p.locator('.svc').first().click(); await check(p, 'customer wizard svc selected', w, theme); await p.click('#next'); await p.waitForSelector('[data-t]'); await p.locator('[data-t]').first().click(); await check(p, 'customer wizard slot selected', w, theme);
    const done = byStatus.COMPLETED; if (done) { await p.goto('/#/booking/' + done); await p.waitForTimeout(600); const star = p.locator('.starpick button').nth(3); if (await star.count()) { await star.click(); await check(p, 'customer review stars picked', w, theme); } }
    await ctx.close(); }
  { const { ctx, p } = await newPage(w, theme); await login(p, BARB[0], BARB[1]);
    const bb = ((await api(p, '/barber/bookings')).bookings || []); const byStatus = {}; for (const k of bb) byStatus[k.status] ??= k.id;
    for (const r of ['#/today', '#/upcoming', '#/customers', '#/plans', '#/reviews', '#/settings', '#/payouts', '#/balance', '#/profile', '#/notifications', ...Object.entries(byStatus).map(([s, id]) => `#/b/${id}`)]) { await p.goto('/' + r); await p.waitForTimeout(700); if (r === '#/settings') await p.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; })); await check(p, 'barber ' + r, w, theme); }
    await ctx.close(); }
  { const { ctx, p } = await newPage(w, theme); await p.goto('/admin.html'); await p.fill('#key', ADMINKEY); await p.click('#lf button'); await p.waitForSelector('.tiles', { timeout: 10000 });
    for (const r of ['home', 'customers', 'barbers', 'bookings', 'decisions', 'payments', 'credits', 'plans', 'earnings', 'ledger', 'analytics', 'reviews', 'waitlist', 'broadcast', 'reports', 'controls', 'rules', 'audit', 'pin', 'deleted', 'testdata']) {
      await p.goto('/admin.html#/' + r); await p.waitForTimeout(800); await check(p, 'admin ' + r, w, theme);
      if (['customers', 'barbers', 'bookings', 'payments'].includes(r)) { const row = p.locator('#ltbl tbody tr, #ltbl .row, .lrow, tbody tr').first(); if (await row.count()) { await row.click().catch(() => {}); await p.waitForTimeout(700); await check(p, 'admin ' + r + ' drawer', w, theme); await p.keyboard.press('Escape'); await p.locator('[data-close]').first().click({ timeout: 800 }).catch(() => {}); } } }
    await ctx.close(); }
}
await b.close();
const rows = [...fails.entries()].sort((a, z) => a[1].ratio - z[1].ratio);
for (const [k, f] of rows) console.log(`FAIL ${k} :: ${f.ratio}:1 (need ${f.need}) on ${f.pages.length} page(s), e.g. ${f.pages[0]}`);
console.log(`\n${pages} screens, ${checks} checks, ${rows.length} distinct failures`); process.exit(rows.length ? 1 : 0);
