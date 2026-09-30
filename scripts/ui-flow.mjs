// Headless UI walkthrough + screenshots (needs playwright-core + Chrome). Usage: BASE=http://localhost:4102 node scripts/ui-flow.mjs
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
const BASE = process.env.BASE || 'http://localhost:4102';
const OUT = new URL('../screenshots/', import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const mk = async () => { const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, baseURL: BASE }); const page = await ctx.newPage(); page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERROR', m.text()); }); page.on('pageerror', (e) => console.log('PAGE ERROR', e.message)); return page; };
const shot = (p, n) => p.screenshot({ path: OUT + n + '.png' });
const cust = await mk(), barber = await mk(), c2 = await mk();
const ok = (n, c) => console.log((c ? 'PASS ' : 'FAIL ') + n);

await cust.goto('/'); await cust.waitForSelector('.hero'); await shot(cust, '01-landing');
await cust.goto('/#/signup?role=customer');
await cust.fill('[name=name]', 'Amaka Demo'); await cust.fill('[name=email]', `amaka${Date.now()}@example.com`); await cust.fill('[name=password]', 'Password123');
await shot(cust, '02-signup');
await cust.click('button[type=submit]');
await cust.waitForSelector('text=Choose a barber'); await shot(cust, '03-customer-home');
await cust.click("text=Mike's Barbershop");
await cust.waitForSelector('text=Opening hours'); await shot(cust, '03b-barber-page');
ok('barber page shown first (no wizard yet)', await cust.locator('.steps').count() === 0 && await cust.locator('#bookbtn').count() === 1);
await cust.click('#bookbtn');
await cust.waitForSelector('text=Pick a service'); await cust.click('text=Haircut + Beard'); await shot(cust, '04-book-service');
await cust.click('#next'); await cust.waitForSelector('[data-t]'); await cust.click('[data-t]:nth-child(3)'); await shot(cust, '05-book-time');
await cust.click('#next'); await cust.waitForSelector('text=Summary'); await cust.click('[data-p=ONLINE]'); await shot(cust, '06-book-summary');
await cust.click('#confirm');
await cust.waitForSelector('text=Simulate successful payment'); await shot(cust, '07-mock-checkout');
await cust.click('#pay');
await cust.waitForSelector('text=Payment received'); await shot(cust, '08-booking-confirmed-paid');
ok('mock payment -> confirmed', await cust.locator('.badge', { hasText: 'CONFIRMED' }).count() > 0 && await cust.locator('.badge', { hasText: 'PAID' }).count() > 0);
await cust.click('#here'); await cust.waitForSelector('.qbox'); await shot(cust, '09-customer-checked-in-queue');
ok('queue box shown after check-in', /ready|#1/i.test(await cust.locator('.qbox').innerText()));

await c2.goto('/#/login'); await c2.fill('[name=identifier]', 'tunde@trimslot.demo'); await c2.fill('[name=password]', 'Customer123!'); await c2.click('button[type=submit]');
await c2.waitForSelector('text=Choose a barber'); await c2.click("text=Mike's Barbershop"); await c2.click('#bookbtn'); await c2.click('text=Regular Haircut'); await c2.click('#next');
await c2.waitForSelector('[data-t]'); await c2.click('[data-t]:nth-child(8)'); await c2.click('#next'); await c2.click('#confirm');
await c2.waitForSelector('text=Cancel until'); await shot(c2, '10-customer2-booked-cancel-window');

await barber.goto('/#/login'); await barber.fill('[name=identifier]', 'mike@trimslot.demo'); await barber.fill('[name=password]', 'Barber123!'); await barber.click('button[type=submit]');
await barber.waitForSelector('text=NOW SERVING'); await barber.waitForSelector('h2:has-text("NEXT")');
await shot(barber, '11-barber-today-before-start');
await barber.click('button:has-text("Mark Present")'); // Tunde
await barber.waitForFunction(() => document.querySelectorAll('.badge.b-green').length >= 1);
await shot(barber, '11b-barber-today-marked-present');
await barber.click('button:has-text("START") >> nth=0'); await barber.waitForSelector('button:has-text("COMPLETE")');
await shot(barber, '12-barber-today-now-serving');
ok('now serving card', (await barber.locator('.now .nm').innerText()).length > 0);
await c2.goto('/#/bookings'); await c2.click('a.card >> nth=0'); await c2.waitForSelector('.qbox');
await shot(c2, '13-customer2-queue-view');
await barber.click('button:has-text("COMPLETE")'); await barber.waitForSelector('text=Done today'); await shot(barber, '14-barber-today-after-complete');
await barber.goto('/#/customers'); await barber.waitForSelector('text=Amaka Demo'); await shot(barber, '15-barber-customers');
await barber.goto('/#/settings'); await barber.waitForSelector('text=Weekly hours'); await shot(barber, '16-barber-settings');
await barber.click('summary:has-text("Weekly hours")'); await barber.waitForSelector('#savesch'); await shot(barber, '16b-barber-settings-hours-open');
// availability change: close a day that has Tunde's booking -> confirmation sheet, customer notified, note on barber page
await barber.click('summary:has-text("Days off")');
const tomorrow = await barber.evaluate(() => { const d = new Date('2026-09-30T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); });
await c2.goto('/#/bookings'); await c2.waitForSelector('h1');
await c2.evaluate(async (date) => { await fetch('/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ barber_id: 1, service_id: 1, date, time: '10:00', payment_option: 'ON_ARRIVAL' }) }); }, tomorrow);
await barber.fill('#off [name=date]', tomorrow);
await barber.fill('#off [name=reason]', 'Family event');
await barber.click('#off button');
await barber.waitForSelector('.sheet'); await shot(barber, '18-barber-availability-confirm');
await barber.click('#sh-yes'); await barber.waitForSelector('.ok');
await c2.goto('/#/notifications'); await c2.waitForSelector('text=Availability updated'); await shot(c2, '19-customer-availability-notification');
ok('customer notified of availability change', await c2.locator('.notif:has-text("Availability updated")').count() > 0);
await c2.goto('/#/barber/1'); await c2.waitForSelector('text=Closed on'); await c2.waitForTimeout(300); await shot(c2, '20-barber-page-closed-note');
// new barber: guided setup
const nb = await mk();
await nb.goto('/#/signup?role=barber'); await nb.fill('[name=name]', 'Emeka Cuts'); await nb.fill('[name=shop_name]', 'Emeka Fades'); await nb.fill('[name=location]', 'Yaba, Lagos');
await nb.fill('[name=email]', `emeka${Date.now()}@example.com`); await nb.fill('[name=password]', 'Password123'); await nb.click('button[type=submit]');
await nb.waitForSelector('text=Awaiting verification');
await nb.goto('/#/settings'); await nb.waitForSelector('text=Step 1 of 3'); await shot(nb, '21-setup-step1-shop');
await nb.click('button:has-text("Continue")'); await nb.waitForSelector('text=What do you offer');
await nb.fill('#addsvc [name=name]', 'Classic cut'); await nb.fill('#addsvc [name=price_naira]', '2500'); await nb.fill('#addsvc [name=duration_min]', '30'); await nb.click('#addsvc button');
await nb.waitForSelector('#next:not([disabled])'); await shot(nb, '22-setup-step2-services');
await nb.click('#next'); await nb.waitForSelector('text=When are you open'); await shot(nb, '23-setup-step3-hours');
await nb.click('#finish'); await nb.waitForSelector('text=Weekly hours'); await shot(nb, '24-settings-compact');
// photo upload from device (tiny generated PNG -> compressed JPEG -> stored)
await nb.click('summary:has-text("Shop profile")');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64');
await nb.setInputFiles('#ph-file', { name: 'shop.png', mimeType: 'image/png', buffer: png });
await nb.waitForFunction(() => document.querySelector('.acc .avatar img'), null, { timeout: 8000 }).catch(() => {});
ok('photo uploaded and shown', await nb.locator('img.avatar').count() > 0);
await shot(nb, '25-settings-photo');
await barber.goto('/#/today'); await barber.waitForSelector('a.card:has-text("Done today"), h2:has-text("Done today")');
await barber.click('h2:has-text("Done today") ~ a.card >> nth=0');
await barber.waitForSelector('text=Timeline'); await shot(barber, '17-barber-booking-timeline');
// ---- plans & credits ----
await barber.goto('/#/profile'); await barber.waitForSelector('text=Shop settings'); await shot(barber, '26-barber-profile');
ok('barber profile hub has Plans entry + bottom tab', await barber.locator('.tabs a:has-text("Plans")').count() === 1 && await barber.locator('.list a:has-text("Plans")').count() === 1);
await barber.click('.tabs a:has-text("Plans")'); await barber.waitForSelector('#addplan');
await barber.fill('#addplan [name=name]', 'Monthly 4 cuts'); await barber.fill('#addplan [name=price_naira]', '9000'); await barber.fill('#addplan [name=sessions]', '4'); await barber.fill('#addplan [name=validity_days]', '30');
await barber.check('#addplan input[name=svc] >> nth=0');
await shot(barber, '28-barber-plans-form');
await barber.click('#addplan button'); await barber.waitForSelector('.svcline:has-text("Monthly 4 cuts")');
await shot(barber, '29-barber-plans-list');
ok('barber created a plan inside platform rules', await barber.locator('.svcline:has-text("Monthly 4 cuts")').count() > 0);
// barber cannot go outside the rules
await barber.fill('#addplan [name=name]', 'Too dear'); await barber.fill('#addplan [name=price_naira]', '9000000'); await barber.fill('#addplan [name=sessions]', '2'); await barber.fill('#addplan [name=validity_days]', '30'); await barber.check('#addplan input[name=svc] >> nth=0');
await barber.click('#addplan button'); await barber.waitForSelector('.err'); await shot(barber, '30-barber-plan-rule-error');
ok('platform limit enforced in UI', /cannot be more/.test(await barber.locator('.err').first().innerText()));
await cust.goto('/#/barber/1'); await cust.waitForSelector('#plans'); await cust.waitForSelector('text=Monthly 4 cuts'); await shot(cust, '31-customer-plans-on-barber');
cust.on('dialog', (d) => d.accept()); c2.on('dialog', (d) => d.accept()); barber.on('dialog', (d) => d.accept());
await c2.goto('/#/wallet'); await c2.goto('/#/barber/1'); await c2.waitForSelector('[data-buy]'); await c2.click('[data-buy]');
await c2.waitForSelector('text=Simulate successful payment'); await c2.click('#pay');
await c2.waitForSelector('text=Plan purchased'); await shot(c2, '32-customer-wallet-after-buy');
ok('plan bought via mock checkout -> wallet', await c2.locator('text=4 of 4 sessions left').count() > 0);
await c2.goto('/#/barber/1'); await c2.click('#bookbtn'); await c2.waitForSelector('text=Pick a service'); await c2.click('text=Kids Haircut'); await c2.click('#next'); await c2.waitForSelector('[data-t]'); await c2.click('[data-t]:nth-child(2)'); await c2.click('#next');
await c2.waitForSelector('text=Use plan session'); await shot(c2, '33-book-with-plan-session');
await c2.click('#confirm'); await c2.waitForSelector('.badge:has-text("PLAN SESSION")'); await shot(c2, '34-booking-paid-with-plan');
ok('booked with a plan session (no payment)', await c2.locator('.badge:has-text("PLAN SESSION")').count() > 0);
await c2.goto('/#/wallet'); await c2.waitForSelector('text=3 of 4 sessions left'); await shot(c2, '35-wallet-balance');
await barber.goto('/#/today'); await barber.goto('/#/plans'); await barber.waitForSelector('text=Plan buyers'); await shot(barber, '36-barber-plan-buyers');
// pay-now warning: slot only secured on payment
await cust.goto('/#/barber/1'); await cust.click('#bookbtn'); await cust.click('text=Regular Haircut'); await cust.click('#next'); await cust.waitForSelector('[data-t]'); await cust.click('[data-t]:nth-child(5)'); await cust.click('#next'); await cust.waitForSelector('text=Summary'); await cust.click('[data-p=ONLINE]');
await cust.waitForSelector('text=only secured once payment completes'); await shot(cust, '37-pay-now-slot-warning');
ok('pay-now warns the slot is only secured once payment completes', await cust.locator('text=only secured once payment completes').count() > 0);
// profile screens
await cust.goto('/#/profile'); await cust.waitForSelector('text=Edit details'); await shot(cust, '38-customer-profile');
await cust.click('#editbtn'); await cust.fill('#acct [name=name]', 'Amaka Demo Jr'); await cust.click('#acct button'); await cust.waitForSelector('text=Amaka Demo Jr');
ok('customer can edit details on Profile', await cust.locator('.prof-head:has-text("Amaka Demo Jr")').count() > 0);
await cust.click('#themesw'); ok('dark mode toggle works', await cust.evaluate(() => document.documentElement.dataset.theme === 'dark')); await shot(cust, '39-customer-profile-dark'); await cust.click('#themesw');
await cust.click('#signout'); await cust.waitForSelector('.hero'); ok('sign out from Profile', await cust.locator('.hero').count() === 1);
await browser.close();
