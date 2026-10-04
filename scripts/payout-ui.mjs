/* End-to-end payout setup through the real UI (mock Paystack): bank list -> resolve -> unknown account -> lookup unavailable (typed-name fallback) -> save -> active.
   Usage: BASE=http://localhost:4102 node scripts/payout-ui.mjs   (account numbers ending 0000 = unknown, 9999 = lookup unavailable) */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:4102';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
fs.mkdirSync('screenshots/payout', { recursive: true });
for (const [theme, width] of [['light', 390], ['dark', 360]]) {
  const ctx = await b.newContext({ viewport: { width, height: 800 } }); await ctx.addInitScript((t) => localStorage.setItem('trimslot_theme', t), theme);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(BASE + '/#/signup?role=barber');
  const em = `payout${Date.now()}${width}${theme}@example.com`;
  await p.fill('[name=name]', 'Pay Out'); await p.fill('[name=shop_name]', 'Payout Shop'); await p.fill('[name=email]', em); await p.fill('[name=password]', 'Passw0rd!x');
  await p.click('button[type=submit]'); await p.waitForTimeout(1500);
  await p.goto(BASE + '/#/payouts'); await p.waitForSelector('#pobank');
  ok((await p.$$eval('#pobank option', (o) => o.length)) > 3, 'bank list loaded');
  ok(await p.isDisabled('#posave'), 'save disabled initially');
  await p.selectOption('#pobank', { index: 1 });
  await p.fill('#poacct', '0123450000'); await p.waitForTimeout(600);
  ok(/couldn.t find that account/i.test(await p.textContent('#poname')), 'unknown account -> clear message');
  ok(await p.isDisabled('#posave'), 'save disabled for unknown account');
  await p.fill('#poacct', '0123459999'); await p.waitForSelector('#pomanual:not(.hidden)', { timeout: 4000 });
  ok(/type the account name/i.test(await p.textContent('#pomnote')), 'fallback note shown');
  ok(await p.isDisabled('#posave'), 'save disabled until a name is typed');
  await p.screenshot({ path: `screenshots/payout/${theme}-${width}-fallback.png` });
  await p.fill('#pomn', 'Ada Obi'); ok(!(await p.isDisabled('#posave')), 'save enabled with typed name');
  await p.click('#posave'); await p.waitForSelector('.payok', { timeout: 6000 });
  const t = await p.textContent('.payok'); ok(/ACTIVE/.test(t) && /9999/.test(t) && /Ada Obi/.test(t) && /NOT VERIFIED/i.test(t), 'active card shows typed name flagged unverified: ' + t.replace(/\s+/g, ' '));
  await p.screenshot({ path: `screenshots/payout/${theme}-${width}-active.png` });
  // change to a normal account: resolves automatically, no manual field
  await p.click('#chg'); await p.selectOption('#pobank', { index: 2 }); await p.fill('#poacct', '0123456789'); await p.waitForTimeout(600);
  ok(/MOCK ACCOUNT 6789/.test(await p.textContent('#poname')), 'resolved name shown'); ok(await p.$eval('#pomanual', (e) => e.classList.contains('hidden')), 'manual field hidden when resolved');
  await p.click('#posave'); await p.waitForTimeout(1500);
  const t2 = await p.textContent('.payok'); ok(/6789/.test(t2) && !/NOT VERIFIED/i.test(t2), 'verified account saved: ' + t2.replace(/\s+/g, ' '));
  // offline: lookup shows a network message with a retry, not a stack of "Failed to fetch"
  await p.click('#chg'); await p.selectOption('#pobank', { index: 1 }); await ctx.setOffline(true); await p.fill('#poacct', '0123456780'); await p.waitForTimeout(700);
  ok(/offline|reach/i.test(await p.textContent('#poname')), 'offline message: ' + (await p.textContent('#poname'))); await ctx.setOffline(false);
  ok(!errs.length, 'no page errors: ' + errs.join(';'));
  await ctx.close();
}
await b.close(); console.log(`payout-ui: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
