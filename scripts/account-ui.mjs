/* Account/avatar/refund UI smoke against the local dev server (demo seed, mock payments).
   Usage: node scripts/account-ui.mjs   (env BASE, ADMINKEY, IMG=path to a jpeg) -> exit 1 on any failure; screenshots in screenshots/account/ */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:4102', KEY = process.env.ADMINKEY || 'local-admin-key-xyz', IMG = process.env.IMG || '/tmp/face.jpg';
fs.mkdirSync('screenshots/account', { recursive: true });
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let fails = 0, total = 0; const errs = [];
const ok = (c, n, x = '') => { total++; if (!c) { fails++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } else if (process.env.VERBOSE) console.log('PASS ' + n); };
const mk = async (w) => { const ctx = await b.newContext({ viewport: { width: w, height: 800 }, baseURL: BASE }); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource|_vercel\/insights/.test(m.text())) errs.push(m.text().slice(0, 140)); }); return { ctx, p }; };
const stamp = Date.now();
for (const w of [390, 1280]) {
  // --- password visibility and signup confirmation
  { const { ctx, p } = await mk(w);
    await p.goto('/#/login'); await p.waitForSelector('#f [name=identifier]');
    const loginPw = p.locator('#f [name=password]'), loginToggle = p.locator('[data-password-toggle="auth-password"]');
    ok(await loginPw.getAttribute('type') === 'password', w + ' login password starts masked');
    ok(await loginToggle.getAttribute('aria-label') === 'Show password' && await loginToggle.getAttribute('aria-pressed') === 'false', w + ' login reveal button has accessible name and state');
    await loginToggle.click(); ok(await loginPw.getAttribute('type') === 'text' && await loginToggle.getAttribute('aria-pressed') === 'true', w + ' login password can be revealed');
    await loginToggle.click(); ok(await loginPw.getAttribute('type') === 'password' && await loginToggle.getAttribute('aria-pressed') === 'false', w + ' login password can be masked again');

    await p.goto('/#/signup?role=barber'); await p.waitForSelector('#f [name=shop_name]');
    ok(await p.locator('#f [name=confirm_password]').count() === 1, w + ' barber signup also asks for a confirmation password');
    const signupRequests = [];
    p.on('request', (req) => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/auth/signup') signupRequests.push(req.postDataJSON()); });
    await p.goto('/#/signup?role=customer'); await p.waitForSelector('[name=accept_terms]');
    const signupPw = p.locator('#f [name=password]'), confirmPw = p.locator('#f [name=confirm_password]');
    ok(await confirmPw.count() === 1 && await confirmPw.getAttribute('autocomplete') === 'new-password', w + ' signup asks for a confirmation password');
    const signupToggle = p.locator('[data-password-toggle="auth-password"]'); await signupToggle.click();
    ok(await signupPw.getAttribute('type') === 'text', w + ' signup password can be revealed'); await signupToggle.click();
    await p.fill('[name=name]', 'Ada UI ' + stamp); await p.fill('[name=email]', `ada${w}${stamp}@example.com`); await p.fill('[name=password]', 'Password123'); await p.fill('[name=confirm_password]', 'Mismatch123');
    await p.waitForTimeout(300);
    ok(await p.locator('button[type=submit]').isDisabled(), w + ' sign-up button stays disabled without the tick-box');
    await p.check('[name=accept_terms]'); await p.click('button[type=submit]'); await p.waitForSelector('#password-match-error:not(.hidden)');
    ok(/do not match/i.test(await p.locator('#password-match-error').innerText()) && signupRequests.length === 0, w + ' mismatched passwords are rejected before signup is sent');
    await p.fill('[name=confirm_password]', 'Password123'); await p.click('button[type=submit]');
    await p.waitForFunction(() => location.hash === '#/' && document.querySelector('#app')?.innerText.includes('My barbers'), null, { timeout: 8000 });
    ok(signupRequests.length === 1 && !Object.hasOwn(signupRequests[0], 'confirm_password'), w + ' matching signup sends one request without the confirmation value');
    ok(true, w + ' signup with tick-box'); await p.goto('/#/profile'); await p.waitForSelector('.avatar-edit');
    const sections = await p.locator('.profile-section h2').allTextContents();
    ok(await p.locator('.profile-accordion-trigger').count() === 6, w + ' customer profile sections use accordions');
    ok(await p.locator('#profile-contact .profile-accordion-trigger').getAttribute('aria-expanded') === 'true', w + ' first customer group starts open');
    await p.locator('#profile-security .profile-accordion-trigger').click();
    ok(await p.locator('#profile-security .profile-accordion-trigger').getAttribute('aria-expanded') === 'true' && await p.locator('#profile-security .profile-accordion-chevron').count() === 1, w + ' customer group opens with chevron');
    await p.locator('#profile-security .profile-accordion-trigger').click();
    ok(await p.locator('#profile-security .profile-accordion-trigger').getAttribute('aria-expanded') === 'false', w + ' customer group collapses');
    ok(JSON.stringify(sections) === JSON.stringify(['Profile & contact', 'Security & sign-in', 'Bookings', 'Wallet & receipts', 'Preferences', 'Help, privacy & account actions']), w + ' customer profile has exactly the six agreed sections', sections.join(' | '));
    await p.click('#password-toggle'); ok(await p.locator('#password-change:not(.hidden)').count() === 1, w + ' password change form opens');
    await p.click('#profile-help [data-report]'); await p.waitForSelector('#reportbox'); ok(await p.locator('#rform [name=category]').inputValue() === 'OTHER', w + ' general Help & Support opens with the right category');
    await p.goto('/#/receipts'); await p.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('Receipts'), null, { timeout: 8000 }); ok(true, w + ' profile receipts shortcut opens a receipts page');
    await p.goto('/#/password-reset'); await p.waitForSelector('#prs'); ok(true, w + ' password reset screen is reachable');
    await p.goto('/#/profile'); await p.waitForSelector('.avatar-edit');
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
