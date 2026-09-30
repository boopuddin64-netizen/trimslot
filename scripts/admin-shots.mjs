// Logs into the admin portal by typing the key, screenshots every section at 390px and 1280px, audits overflow and button sizes.
// Usage: BASE=http://localhost:4102 KEY=... node scripts/admin-shots.mjs [outdir] [--live]
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:4102', KEY = process.env.KEY || '';
const OUT = process.argv[2] || new URL('../screenshots/admin/', import.meta.url).pathname;
const ONLY_LOGIN = process.argv.includes('--login-only');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let problems = 0; const log = (ok, m) => { if (!ok) problems++; console.log((ok ? 'ok   ' : 'FAIL ') + m); };
const SECT = ['overview', 'barbers', 'bookings', 'payments', 'decisions', 'plans', 'credits', 'rules', 'audit'];
for (const W of [390, 1280]) {
  const ctx = await browser.newContext({ viewport: { width: W, height: W < 500 ? 780 : 860 }, deviceScaleFactor: 2, isMobile: W < 500, hasTouch: W < 500, baseURL: BASE });
  const p = await ctx.newPage(); p.on('pageerror', (e) => log(false, 'PAGE ERROR ' + e.message));
  const audit = async (label) => {
    const r = await p.evaluate(() => { const vw = document.documentElement.clientWidth; const o = []; if (document.documentElement.scrollWidth > vw + 1) o.push('page ' + document.documentElement.scrollWidth + '>' + vw);
      for (const el of document.querySelectorAll('main *, header *')) { const b = el.getBoundingClientRect(); if (b.width && (b.right > vw + 1 || b.left < -1) && !el.closest('.anav') && !el.closest('.scroll')) o.push(el.tagName + '.' + el.className + ' ' + Math.round(b.left) + '..' + Math.round(b.right)); }
      const btn = []; for (const el of document.querySelectorAll('.btn')) { const b = el.getBoundingClientRect(); if (b.width && (b.height < 30 || b.height > 48)) btn.push(el.textContent.trim().slice(0, 18) + ' h=' + Math.round(b.height)); }
      return { o, btn }; });
    log(!r.o.length, `${W}px ${label}: no overflow ${r.o.slice(0, 3).join(' | ')}`); log(!r.btn.length, `${W}px ${label}: button sizes ${r.btn.slice(0, 3).join(' | ')}`);
  };
  const shot = async (name) => { await p.evaluate(() => window.scrollTo(0, 0)); await p.screenshot({ path: `${OUT}${W}/${name}.png` }); await p.screenshot({ path: `${OUT}${W}/${name}-full.png`, fullPage: true }); };
  fs.mkdirSync(OUT + W, { recursive: true });
  await p.goto('/admin.html'); await p.waitForSelector('#key'); await p.waitForTimeout(300); await shot('00-login'); await audit('login');
  await p.fill('#key', 'definitely-wrong'); await p.click('#lf button[type=submit]'); await p.waitForSelector('#lmsg:not(.hidden)'); await p.waitForTimeout(200); await p.screenshot({ path: `${OUT}${W}/01-login-wrong-key.png` });
  if (ONLY_LOGIN) { await ctx.close(); continue; }
  await p.fill('#key', KEY); await p.click('#lf button[type=submit]'); await p.waitForSelector('#shell:not(.hidden)');
  const stored = await p.evaluate(() => ({ s: Object.keys(sessionStorage), l: Object.keys(localStorage).filter((k) => /admin|key/i.test(k)) })); log(stored.s.includes('trimslot_admin_key') && !stored.l.length, `${W}px key only in sessionStorage ${JSON.stringify(stored)}`);
  let i = 2;
  for (const s of SECT) { await p.goto('/admin.html#/' + s); await p.waitForTimeout(700); await shot(String(i++).padStart(2, '0') + '-' + s); await audit(s); }
  await p.goto('/admin.html#/payments'); await p.waitForTimeout(400); const pill = p.locator('.pills button, .pills a, [data-filter]').filter({ hasText: /needs refund/i }).first(); if (await pill.count()) { await pill.click(); await p.waitForTimeout(500); await shot(String(i++).padStart(2, '0') + '-payments-needs-refund'); }
  await p.evaluate(() => { localStorage.setItem('theme', 'dark'); }); await p.goto('/admin.html#/overview'); await p.waitForTimeout(600);
  await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark')); await shot(String(i++).padStart(2, '0') + '-overview-dark');
  await ctx.close();
}
console.log(problems ? `\n${problems} problem(s)` : '\nAll admin layout checks passed'); await browser.close(); process.exit(problems ? 1 : 0);
