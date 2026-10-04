/* Load-speed table: headless Chrome (playwright-core) on a phone-sized viewport with slow-4G network + 4x CPU throttling, logged in as the demo customer.
   Scenarios: cold (no cache, no service worker) · warm (second load, service worker active when the build has one) · offline (reload with no network).
   Reports DOMContentLoaded, load, First Contentful Paint, time until the main screen has real content (not placeholders), bytes over the network and request count (median of RUNS).
   Usage: BASE=http://localhost:4110 node scripts/speed-measure.mjs   (env RUNS=3, WIDTHS=360,390, LABEL=name, JSON=out.json). LOCAL throw-away server only: `npm run speed`. */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:4110';
const RUNS = Number(process.env.RUNS || 3), WIDTHS = (process.env.WIDTHS || '360,390').split(',').map(Number), LABEL = process.env.LABEL || 'run';
const [CUST_ID, CUST_PW] = (process.env.CUST || 'chidi@trimslot.demo:Customer123!').split(':');
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const med = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

// log in once (unthrottled) and keep only the login cookie, so every measured run starts with an empty cache and empty localStorage
const lc = await b.newContext({ baseURL: BASE }); const lp = await lc.newPage();
await lp.goto('/#/login'); await lp.fill('[name=identifier]', CUST_ID); await lp.fill('[name=password]', CUST_PW); await lp.click('button[type=submit]');
await lp.waitForSelector('#tabs:not(.hidden)', { timeout: 15000 });
const cookies = await lc.cookies(); await lc.close();

const INIT = () => {   // time until #app shows real content (anything that is not the grey placeholder cards)
  window.__content = null;
  const chk = () => { const a = document.getElementById('app'); if (a && a.children.length && !a.querySelector('.sk') && window.__content == null) { window.__content = performance.now(); return true; } return false; };
  new MutationObserver(() => { chk(); }).observe(document, { childList: true, subtree: true, characterData: true });
};
async function load(ctx, w, opts = {}) {
  const p = await ctx.newPage(); const cdp = await ctx.newCDPSession(p);
  await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
  await cdp.send('Network.emulateNetworkConditions', { offline: !!opts.offline, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  let bytes = 0, reqs = 0; const live = new Map();
  cdp.on('Network.responseReceived', (e) => live.set(e.requestId, e.response));
  cdp.on('Network.loadingFinished', (e) => { reqs++; bytes += e.encodedDataLength || 0; });
  const t0 = Date.now(); let err = null;
  await ctx.setOffline(!!opts.offline);   // also cuts the service worker's own network (page-level emulation alone does not)
  try { await p.goto('/#/', { waitUntil: 'load', timeout: 45000 }); } catch (e) { err = String(e.message).split('\n')[0].slice(0, 80); }
  let content = null;
  if (!err) { try { await p.waitForFunction(() => window.__content != null, null, { timeout: 30000 }); } catch { /* none */ } }
  await p.waitForTimeout(700);
  const m = err ? {} : await p.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0], fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return { dcl: n && n.domContentLoadedEventEnd, load: n && n.loadEventEnd, fcp: fcp && fcp.startTime, content: window.__content, text: (document.getElementById('app') || {}).innerText || '', swc: !!navigator.serviceWorker && !!navigator.serviceWorker.controller };
  }).catch(() => ({}));
  if (opts.offline) await ctx.setOffline(false);
  const r = { ...m, bytes, reqs, err, wall: Date.now() - t0, hasData: !!(m.text && /Hi,|Book|Bookings/i.test(m.text)) };
  return { p, r };
}
const rows = [];
for (const w of WIDTHS) {
  const acc = { cold: [], warm: [], offline: [] };
  for (let i = 0; i < RUNS; i++) {
    const ctx = await b.newContext({ baseURL: BASE, viewport: { width: w, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await ctx.addCookies(cookies); await ctx.addInitScript(INIT);
    const c = await load(ctx, w); acc.cold.push(c.r); await c.p.waitForTimeout(3500); await c.p.close();   // let a service worker (if any) install + precache
    const wm = await load(ctx, w); acc.warm.push(wm.r); await wm.p.close();
    const off = await load(ctx, w, { offline: true }); acc.offline.push(off.r); await off.p.close();
    await ctx.close();
  }
  for (const k of ['cold', 'warm', 'offline']) {
    const a = acc[k];
    rows.push({ width: w, scenario: k, dcl: med(a.map((x) => x.dcl)), load: med(a.map((x) => x.load)), fcp: med(a.map((x) => x.fcp)), content: med(a.map((x) => x.content)), kb: med(a.map((x) => x.bytes / 1024)), reqs: med(a.map((x) => x.reqs)), ok: a.filter((x) => !x.err && x.hasData).length + '/' + a.length, sw: a.filter((x) => x.swc).length + '/' + a.length, err: a.find((x) => x.err)?.err || '' });
  }
}
await b.close();
const f = (v) => v == null ? '—' : Math.round(v);
console.log(`\n[${LABEL}] slow-4G (1.6 Mbps, 150 ms) + 4x CPU, median of ${RUNS}`);
console.log('width scenario  DCL(ms) load(ms) FCP(ms) content(ms) KB   reqs  data-shown  sw-controlled  error');
for (const r of rows) console.log(`${r.width}   ${r.scenario.padEnd(8)} ${String(f(r.dcl)).padStart(7)} ${String(f(r.load)).padStart(8)} ${String(f(r.fcp)).padStart(7)} ${String(f(r.content)).padStart(10)} ${String(f(r.kb)).padStart(5)} ${String(f(r.reqs)).padStart(5)}  ${r.ok.padStart(9)}  ${r.sw.padStart(12)}   ${r.err}`);
if (process.env.JSON) fs.writeFileSync(process.env.JSON, JSON.stringify(rows, null, 1));
