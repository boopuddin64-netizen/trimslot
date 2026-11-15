/* Barber profile section/flow smoke and optional phone preview.
   Run against a local server; EMAIL_VERIFICATION_REQUIRED=false proves the barber launch check is independent of optional customer prompts.
   Example: EMAIL_VERIFICATION_REQUIRED=false OUT=/workspace/barber-profile-previews npx tsx scripts/with-server.ts scripts/barber-profile-ui.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/workspace/pw-tools/node_modules/playwright-core');

const BASE = process.env.BASE || 'http://localhost:4102';
const OUT = process.env.OUT || 'screenshots/barber-profile';
fs.mkdirSync(OUT, { recursive: true });
const expected = ['Shop status & identity', 'Booking link/QR', 'Shop tools & payouts', 'Contact & verification', 'Security', 'Preferences, privacy & help'];
const sectionFiles = [
  ['barber-profile-status', 'barber-section-1-shop-status-identity.png'],
  ['barber-profile-link', 'barber-section-2-booking-link-qr.png'],
  ['barber-profile-tools', 'barber-section-3-shop-tools-payouts.png'],
  ['barber-profile-contact', 'barber-section-4-contact-verification.png'],
  ['barber-profile-security', 'barber-section-5-security.png'],
  ['barber-profile-preferences', 'barber-section-6-preferences-privacy-help.png'],
];
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const issues = [];
async function runWidth(width, capture = false) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: width < 720 ? 2 : 1, baseURL: BASE });
  await context.addInitScript(() => { try { localStorage.setItem('trimslot_theme', 'dark'); } catch { /* private context */ } });
  const page = await context.newPage();
  page.on('pageerror', (e) => issues.push(`${width}px pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource|_vercel\/insights/.test(m.text())) issues.push(`${width}px console: ${m.text().slice(0, 180)}`); });
  await page.route('**/_vercel/insights/script.js', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));

  const cfg = await page.request.get('/api/config').then((r) => r.json());
  assert.equal(typeof cfg.email_verification, 'boolean', 'the server exposes the global customer verification switch');
  const stamp = `${Date.now()}-${width}`;
  await page.goto('/#/signup?role=barber');
  await page.waitForSelector('#f [name=shop_name]');
  await page.fill('#f [name=name]', `Barber Preview ${width}`);
  await page.fill('#f [name=shop_name]', `Preview Cuts ${width}`);
  await page.fill('#f [name=location]', 'Yaba, Lagos');
  await page.fill('#f [name=email]', `barber.preview.${stamp}@example.com`);
  await page.fill('#f [name=password]', 'PreviewPass123!');
  await page.fill('#f [name=confirm_password]', 'PreviewPass123!');
  await page.check('#f [name=accept_terms]');
  await page.check('#f [name=accept_barber_agreement]');
  await page.click('#f button[type=submit]');
  await page.waitForFunction(() => location.hash.startsWith('#/verify-email') || location.hash === '#/' || location.hash.startsWith('#/today'), null, { timeout: 12000 });
  await page.goto('/#/profile');
  await page.waitForSelector('#barber-profile-status', { timeout: 12000 });
  await page.waitForSelector('#profile-data-slot #exp', { timeout: 12000 });
  await page.waitForFunction(() => document.querySelectorAll('.profile-section').length === 6, null, { timeout: 8000 });
  const headings = await page.locator('.profile-section h2').allTextContents();
  assert.equal(await page.locator('.profile-accordion-trigger').count(), 6, 'all barber profile groups use accordions');
  assert.equal(await page.locator('#barber-profile-status .profile-accordion-trigger').getAttribute('aria-expanded'), 'true', 'first barber group starts open');
  await page.locator('#barber-profile-security .profile-accordion-trigger').click();
  assert.equal(await page.locator('#barber-profile-security .profile-accordion-trigger').getAttribute('aria-expanded'), 'true', 'barber accordion opens');
  await page.locator('#barber-profile-security .profile-accordion-trigger').press('Space');
  assert.equal(await page.locator('#barber-profile-security .profile-accordion-trigger').getAttribute('aria-expanded'), 'false', 'barber accordion supports keyboard collapse');
  assert.deepEqual(headings, expected, `${width}px profile has exactly the six agreed sections`);
  assert.equal(await page.locator('#barber-profile-contact .badge').first().textContent(), 'Not verified');
  assert.equal(await page.locator('#barber-profile-contact a[href^="#/verify-email"]').count(), 1, 'email verification action is visible');
  assert.equal(await page.locator('#barber-profile-security #password-toggle').count(), 1, 'change password is present');
  assert.equal(await page.locator('#barber-profile-security a[href="#/password-reset"]').count(), 1, 'password reset is present');
  assert.equal(await page.locator('#barber-profile-preferences [data-report]').count(), 1, 'Help & Support is present');
  assert.equal(await page.locator('#exp').count(), 1, 'data export is present');
  assert.equal(await page.locator('#delacct').count(), 1, 'account deletion is present');
  assert.match(await page.locator('#barber-profile-status').innerText(), /Waiting for review/);
  assert.match(await page.locator('#barber-profile-link').innerText(), /QR code|booking link/i);
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(horizontalOverflow, false, `${width}px profile has no horizontal overflow`);

  if (capture) {
    await page.waitForTimeout(500);
    await page.addStyleTag({ content: '.tabs{display:none!important}' });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${OUT}/barber-profile-full-page.png`, fullPage: true, animations: 'disabled' });
    for (const [id, name] of sectionFiles) {
      const section = page.locator(`#${id}`);
      await section.scrollIntoViewIfNeeded();
      await section.screenshot({ path: `${OUT}/${name}`, animations: 'disabled' });
    }
  }

  await page.click('#password-toggle');
  assert.equal(await page.locator('#password-change').isVisible(), true, `${width}px change-password form opens`);
  await page.click('#barber-profile-security a[href="#/password-reset"]');
  await page.waitForSelector('#prs');
  await page.goto('/#/profile');
  await page.waitForSelector('#barber-profile-preferences [data-report]');
  await page.click('#barber-profile-preferences [data-report]');
  await page.waitForSelector('#reportbox');
  assert.equal(await page.locator('#rform [name=category]').inputValue(), 'OTHER', `${width}px Help & Support opens as a general report`);
  await context.close();
}

try {
  await runWidth(390, true);
  await runWidth(1280, false);
  assert.deepEqual(issues, [], 'no browser JavaScript or console errors');
  console.log(JSON.stringify({ ok: true, widths: [390, 1280], sections: expected, screenshots: [`${OUT}/barber-profile-full-page.png`, ...sectionFiles.map(([, name]) => `${OUT}/${name}`)], browserErrors: issues }, null, 2));
} catch (e) {
  console.error(e);
  if (issues.length) console.error('Browser errors:', issues);
  process.exitCode = 1;
} finally {
  await browser.close();
}
