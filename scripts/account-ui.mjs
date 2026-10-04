/* Account/avatar/refund UI smoke against the local dev server (demo seed, mock payments).
   Usage: node scripts/account-ui.mjs   (env BASE, ADMINKEY, IMG=path to a jpeg) -> exit 1 on any failure; screenshots in screenshots/account/ */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:4102', KEY = process.env.ADMINKEY || 'local-admin-key-xyz', IMG = process.env.IMG || '/tmp/face.jpg';
fs.mkdirSync('screenshots/account', { recursive: true });
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let fails = 0, total = 0; const errs = [];
const ok = (c, n, x = '') => { total++; if (!c) { fails++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } else if (process.env.VERBOSE) console.log('PASS ' + n); };
const mk = async (w) => { const ctx = await b.newContext({ viewport: { width: w, height: 800 }, baseURL: BASE }); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 140)); }); return { ctx, p }; };
const stamp = Date.now();
for (const w of [390, 1280]) {
  // --- sign-up needs the tick-box
  { const { ctx, p } = await mk(w); await p.goto('/#/signup?role=customer'); await p.waitForSelector('[name=accept_terms]');
    await p.fill('[name=name]', 'Ada UI ' + stamp); await p.fill('[name=email]', `ada${w}${stamp}@example.com`); await p.fill('[name=password]', 'Password123');
    await p.waitForTimeout(300);
    ok(await p.locator('button[type=submit]').isDisabled(), w + ' sign-up button stays disabled without the tick-box');
    await p.check('[name=accept_terms]'); await p.click('button[type=submit]'); await p.waitForFunction(() => !location.hash.includes('signup'), null, { timeout: 8000 });
    ok(true, w + ' signup with tick-box'); await p.goto('/#/profile'); await p.waitForSelector('.avatar-edit');
    ok(await p.locator('#exp').count() === 1 && await p.locator('#delacct').count() === 1, w + ' profile has export + delete');
    await p.setInputFiles('#av-file', IMG); await p.waitForSelector('.sheet.crop'); await p.click('[data-save]'); await p.waitForSelector('.avatar-edit .av.has', { timeout: 8000 }); ok(true, w + ' avatar uploaded and shown round');
    const r = await p.evaluate(() => { const e = document.querySelector('.avatar-edit .av'); const s = getComputedStyle(e); return [s.borderRadius, e.offsetWidth, e.offsetHeight]; });
    ok(r[1] === r[2] && /50%|^\d+px/.test(r[0]), w + ' avatar is square box with round radius', r.join(','));
    await p.screenshot({ path: `screenshots/account/${w}-profile.png` });
    const dl = p.waitForEvent('download'); await p.click('#exp'); const d = await dl; ok(/trimslot-my-data/.test(d.suggestedFilename()), w + ' export downloads JSON');
    await p.click('#delacct'); await p.waitForSelector('.scrim form'); await p.screenshot({ path: `screenshots/account/${w}-delete.png` }); await p.click('#delno'); ok(await p.locator('.scrim').count() === 0, w + ' delete dialog closes');
    await ctx.close(); }
  // --- barber sees the avatar after a booking
  // --- admin pages
  { const { ctx, p } = await mk(w); await p.goto('/admin.html'); await p.evaluate((k) => sessionStorage.setItem('trimslot_admin_key', k), KEY); await p.goto('/admin.html#/home'); await p.waitForTimeout(800);
    for (const r of ['decisions', 'alerts', 'controls', 'customers', 'bookings', 'waitlist']) {
      await p.goto('/admin.html#/' + r); await p.waitForTimeout(1000);
      const t = await p.evaluate(() => document.querySelector('#app').innerText.slice(0, 80).replace(/\n/g, ' '));
      ok(!/Request failed|is not defined|undefined/.test(t) && t.length > 5, `${w} admin ${r} renders`, t);
      if (r === 'controls') { ok(await p.locator('#numcard').count() === 1, w + ' controls has published numbers card'); ok(await p.locator('#nf [name=cancel_cutoff_min]').inputValue() === '30', w + ' cancel lock default 30'); ok(await p.locator('#nf [name=refund_auto_approve_hours]').inputValue() === '3', w + ' auto-approve default 3'); }
      if (r === 'alerts') { ok(await p.locator('#apf input[type=checkbox]').count() >= 9, w + ' alerts prefs panel'); }
      await p.screenshot({ path: `screenshots/account/${w}-admin-${r}.png` });
    }
    await ctx.close(); }
}
await b.close();
console.log(errs.length ? 'console/page errors: ' + [...new Set(errs)].slice(0, 5).join(' | ') : 'console/page errors: 0');
console.log(`${total - fails}/${total} checks passed`); process.exit(fails || errs.length ? 1 : 0);
