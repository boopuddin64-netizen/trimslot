// Visits every screen at 390px and 360px, screenshots it, and checks: no horizontal overflow, no control hidden under the floating tab bar,
// button heights in the 36-48px range (no chunky/full-width except .block), nothing wider than the viewport. Usage: BASE=http://localhost:4102 node scripts/ui-check.mjs [outdir]
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:4102';
const OUT = process.argv[2] || new URL('../screenshots/v3/', import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let problems = 0;
const log = (ok, m) => { if (!ok) problems++; console.log((ok ? 'ok   ' : 'FAIL ') + m); };
async function audit(page, label) {
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth; const out = { over: [], btn: [], hidden: [] };
    if (document.documentElement.scrollWidth > vw + 1) out.over.push('page scrollWidth ' + document.documentElement.scrollWidth + ' > ' + vw);
    for (const el of document.querySelectorAll('main *, .tabs, .topbar')) { const b = el.getBoundingClientRect(); if (b.width && (b.right > vw + 1 || b.left < -1) && !el.closest('.days')) out.over.push(el.tagName + '.' + el.className + ' ' + Math.round(b.left) + '..' + Math.round(b.right)); }
    for (const el of document.querySelectorAll('.btn')) { const b = el.getBoundingClientRect(); if (!b.width) continue; if (b.height < 34 || b.height > 48) out.btn.push(el.textContent.trim().slice(0, 20) + ' h=' + Math.round(b.height)); const fs = parseFloat(getComputedStyle(el).fontSize); if (fs > 15.5) out.btn.push('font ' + fs); }
    const tabs = document.querySelector('.tabs'); const tb = tabs && !tabs.classList.contains('hidden') ? tabs.getBoundingClientRect() : null;
    window.scrollTo(0, document.body.scrollHeight);
    if (tb) for (const el of document.querySelectorAll('main a, main button, main input, main select, main textarea, .foot a')) { const b = el.getBoundingClientRect(); if (!b.width || getComputedStyle(el).display === 'none' || (el.closest('details') && !el.closest('details').open && !el.closest('summary'))) continue; if (b.bottom > tb.top - 4 && b.top < tb.bottom) out.hidden.push(el.tagName + ' ' + (el.textContent || el.id).trim().slice(0, 20)); }
    return out;
  });
  log(!r.over.length, `${label}: no horizontal overflow ${r.over.slice(0, 3).join(' | ')}`);
  log(!r.btn.length, `${label}: button sizes ok ${r.btn.slice(0, 4).join(' | ')}`);
  log(!r.hidden.length, `${label}: nothing under the tab bar at page bottom ${r.hidden.slice(0, 3).join(' | ')}`);
}
for (const W of [390, 360]) {
  fs.mkdirSync(OUT + W, { recursive: true });
  const mk = async () => { const ctx = await browser.newContext({ viewport: { width: W, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, baseURL: BASE }); const p = await ctx.newPage(); p.on('pageerror', (e) => log(false, 'PAGE ERROR ' + e.message)); return p; };
  const visit = async (p, hash, name, wait) => { await p.goto('/' + hash); if (wait) await p.waitForSelector(wait, { timeout: 8000 }).catch(() => log(false, name + ' missing ' + wait)); await p.waitForTimeout(350); await p.evaluate(() => window.scrollTo(0, 0)); await p.screenshot({ path: `${OUT}${W}/${name}.png` }); await p.screenshot({ path: `${OUT}${W}/${name}-full.png`, fullPage: true }); await audit(p, `${W}px ${name}`); };
  const anon = await mk();
  await visit(anon, '', '01-landing', '.hero'); await visit(anon, '#/login', '02-login', '#f'); await visit(anon, '#/signup?role=barber', '03-signup-barber', '#f');
  await anon.goto('/#/login'); await anon.waitForSelector('#f');
  const c = await mk(); await c.goto('/#/login'); await c.fill('[name=identifier]', 'chidi@trimslot.demo'); await c.fill('[name=password]', 'Customer123!'); await c.click('button[type=submit]'); await c.waitForSelector('text=Choose a barber');
  await visit(c, '#/', '10-customer-home', 'text=Choose a barber');
  await visit(c, '#/barber/1', '11-barber-page', '#bookbtn');
  await visit(c, '#/book/1', '12-book-service', 'text=Pick a service');
  await c.click('.svc >> nth=0'); await c.click('#next'); await c.waitForSelector('[data-t]'); await c.click('[data-t]:nth-child(2)'); await audit(c, `${W}px 13-book-time (selected)`); await c.screenshot({ path: `${OUT}${W}/13-book-time.png` });
  await c.click('#next'); await c.waitForSelector('text=Summary'); await c.click('[data-p=ONLINE]'); await c.waitForTimeout(200); await c.screenshot({ path: `${OUT}${W}/14-book-summary.png`, fullPage: true }); await audit(c, `${W}px 14-book-summary (pay now)`);
  await visit(c, '#/bookings', '15-bookings', 'h1'); await visit(c, '#/wallet', '16-wallet', 'text=Plans'); await visit(c, '#/profile', '17-customer-profile', 'text=Edit details'); await visit(c, '#/notifications', '18-notifications', 'h1');
  const b = await mk(); await b.goto('/#/login'); await b.fill('[name=identifier]', 'mike@trimslot.demo'); await b.fill('[name=password]', 'Barber123!'); await b.click('button[type=submit]'); await b.waitForSelector('.tabs');
  await visit(b, '#/today', '20-barber-today', 'h1'); await visit(b, '#/upcoming', '21-barber-upcoming', 'h1'); await visit(b, '#/customers', '22-barber-customers', 'h1'); await visit(b, '#/plans', '23-barber-plans', '#addplan');
  await visit(b, '#/profile', '24-barber-profile', 'text=Shop settings'); await visit(b, '#/settings', '25-barber-settings', 'text=Weekly hours');
  await b.click('summary:has-text("Weekly hours")'); await b.waitForSelector('#savesch'); await audit(b, `${W}px 26-settings-hours-open`); await b.screenshot({ path: `${OUT}${W}/26-settings-hours-open-full.png`, fullPage: true });
  await visit(b, '#/b/1', '27-barber-booking', 'text=Timeline');
  await c.context().close(); await b.context().close(); await anon.context().close();
}
console.log(problems ? `\n${problems} problem(s)` : '\nAll layout checks passed'); await browser.close(); process.exit(problems ? 1 : 0);
