/* Plan-fit and Plans dashboard smoke against a local server (demo seed, mock payments).
   Plan contents are kept explicit, while the customer and barber summaries update every 10 seconds.
   Example: OUT=/workspace/trimslot-previews npx tsx scripts/with-server.ts scripts/plans-ui.mjs */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:4112';
const OUT = process.env.OUT || 'screenshots/plans';
fs.mkdirSync(OUT, { recursive: true });
const call = async (p, o = {}, ck) => { const r = await fetch(BASE + '/api' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(ck ? { Cookie: ck } : {}), ...(o.headers || {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); let j = null; try { j = await r.json(); } catch { /* none */ } return { r, j }; };
const login = async (i, pw) => (await call('/auth/login', { method: 'POST', body: { identifier: i, password: pw } })).r.headers.get('set-cookie').split(';')[0];
let fails = 0, total = 0; const ok = (c, n, x = '') => { total++; if (!c) { fails++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } else if (process.env.VERBOSE) console.log('PASS ' + n); };
const mike = await login('mike@trimslot.demo', 'Barber123!');
const stamp = Date.now();
const email = `planfit${stamp}@example.com`;
const su = await call('/auth/signup', { method: 'POST', body: { role: 'customer', name: 'Plan Fit', email, password: 'Password123', accept_terms: true } });
const cust = await login(email, 'Password123');
const barberId = 1;
await call('/b/' + (await call('/barber/share', {}, mike)).j.code, {}, cust); // opening the barber's link is how a customer gets to a shop
const svcs = (await call('/barbers/' + barberId, {}, cust)).j.services;
const byName = (n) => svcs.find((s) => s.name === n);
const kids = byName('Kids Haircut'), reg = byName('Regular Haircut'), beard = byName('Haircut + Beard');
const mk = async (name, ids, price = 40000) => {
  const r = await call('/barber/plans', { method: 'POST', body: { name, price_naira: price, sessions: 4, validity_days: 30, service_ids: ids } }, mike);
  if (r.r.status !== 201) { console.log('plan create failed', JSON.stringify(r.j)); return r.j.id; }
  const approved = await call(`/admin/plans/${r.j.id}/approval`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.ADMIN_KEY || 'local-admin-key-xyz'}` }, body: { status: 'APPROVED' } });
  if (!approved.r.ok) console.log('local plan approval failed', approved.r.status, JSON.stringify(approved.j));
  return r.j.id;
};
const buyPlan = async (planId) => { const b = await call(`/plans/${planId}/buy`, { method: 'POST' }, cust); await call(`/payments/mock/${b.j.reference}/complete`, { method: 'POST' }); await fetch(`${BASE}/api/payments/callback?reference=${b.j.reference}`, { redirect: 'manual' }); };
const pKids = await mk('Kids pack', [kids.id]);
await buyPlan(pKids);
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const errs = [];
const go = async (w, dark, svc) => {
  const ctx = await b.newContext({ viewport: { width: w, height: 844 }, colorScheme: dark ? 'dark' : 'light', baseURL: BASE });
  await ctx.addCookies([{ name: cust.split('=')[0], value: cust.split('=').slice(1).join('='), url: BASE }]);
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`/#/book/${barberId}`); await p.waitForSelector(`[data-s="${svc.id}"]`);
  return { ctx, p };
};
const toPay = async (p, svc) => { await p.click(`[data-s="${svc.id}"]`); await p.click('#next'); await p.waitForSelector('[data-t]'); await p.click('[data-t]'); await p.click('#next'); await p.waitForSelector('#confirm'); await p.waitForTimeout(200); };
for (const w of [390, 1280]) for (const dark of [false, true]) {
  const tag = `${w}${dark ? 'd' : 'l'}`;
  // one plan covers Kids only: Kids -> plan preselected; Regular -> plan not offered, with a reason
  { const { ctx, p } = await go(w, dark, kids); await toPay(p, kids);
    ok(await p.locator('[data-p="PLAN"]').count() === 1, tag + ' kids cut: one plan session option');
    ok(await p.locator('[data-p="PLAN"].on').count() === 1, tag + ' kids cut: the only matching plan is preselected');
    ok(/Kids pack/.test(await p.locator('[data-p="PLAN"]').innerText()), tag + ' option names the plan');
    ok(await p.locator('[data-p="ONLINE"]').count() === 1, tag + ' "pay normally" is still offered');
    await p.screenshot({ path: `${OUT}/${tag}-kids.png`, fullPage: true }); await ctx.close(); }
  { const { ctx, p } = await go(w, dark, reg); await toPay(p, reg);
    ok(await p.locator('[data-p="PLAN"]').count() === 0, tag + ' regular cut: no plan option (not included)');
    ok(await p.locator('#plan-nofit').count() === 1 && /Kids Haircut/.test(await p.locator('#plan-nofit').innerText()), tag + ' regular cut: tells which services the plan covers');
    await p.screenshot({ path: `${OUT}/${tag}-regular.png`, fullPage: true }); await ctx.close(); }
}
// two matching plans: no preselect, the customer picks one and the booking names it
const pFam = await mk('Family pack', [kids.id, reg.id], 60000); await buyPlan(pFam);
{ const { ctx, p } = await go(390, false, kids); await toPay(p, kids);
  ok(await p.locator('[data-p="PLAN"]').count() === 2, 'two matching plans are both offered');
  ok(await p.locator('[data-p="PLAN"].on').count() === 0, 'with two matching plans nothing is preselected');
  await p.locator('[data-p="PLAN"]', { hasText: 'Family pack' }).click(); await p.waitForTimeout(200);
  ok(/Family pack/.test(await p.locator('[data-p="PLAN"].on').innerText()), 'customer picks the Family pack');
  let sent = null; p.on('request', (r) => { if (r.method() === 'POST' && /\/api\/bookings$/.test(r.url())) sent = r.postDataJSON(); });
  await p.click('#confirm'); await p.waitForTimeout(1200);
  ok(sent && sent.payment_option === 'PLAN' && sent.plan_purchase_id, 'booking request names the chosen plan purchase', JSON.stringify(sent));
  const w2 = (await call('/me/wallet', {}, cust)).j.plans;
  ok(w2.find((x) => /Family/.test(x.plan_name))?.sessions_used === 1 && w2.find((x) => /Kids pack/.test(x.plan_name))?.sessions_used === 0, 'the chosen plan was charged, not the other one');
  await p.evaluate(() => { localStorage.setItem('trimslot_theme', 'dark'); document.documentElement.dataset.theme = 'dark'; });
  await p.goto('/#/wallet'); await p.waitForSelector('#wallet-plans table.plan-table'); await p.waitForTimeout(650);
  const walletText = await p.locator('#wallet-plans').innerText();
  ok(/Covers: .*Kids Haircut/.test(walletText), 'wallet shows what each plan covers');
  ok(await p.locator('#wallet-plans').evaluate((e) => e.open), 'customer active plans are the primary open section');
  ok(!(await p.locator('#wallet-rules').evaluate((e) => e.open)), 'customer rules stay collapsed until requested');
  ok(Number(await p.locator('[data-plan-counter="wallet-sessions"]').innerText()) > 0, 'customer live session counter reflects available sessions');
  ok(await p.locator('[data-plan-counter="wallet-sessions"]').getAttribute('data-count-ready') === '1', 'customer counter initializes accessibly');
  const walletLayout = await p.evaluate(() => {
    const summary = document.querySelector('.plan-live-summary'), metric = document.querySelector('.plan-metric'), header = document.querySelector('#wallet-plans > summary'), cell = document.querySelector('#wallet-plans table.plan-table tbody td');
    return { summaryHeight: summary.getBoundingClientRect().height, metricBorder: getComputedStyle(metric).borderTopWidth, headerHeight: header.getBoundingClientRect().height, cellFont: parseFloat(getComputedStyle(cell).fontSize), cellPadding: parseFloat(getComputedStyle(cell).paddingTop) };
  });
  ok(walletLayout.summaryHeight <= 155 && walletLayout.metricBorder === '0px', '390px customer live summary is compact, with no oversized metric tiles', JSON.stringify(walletLayout));
  ok(walletLayout.headerHeight >= 44 && walletLayout.headerHeight <= 58 && walletLayout.cellFont >= 12 && walletLayout.cellPadding >= 5, 'customer disclosure remains easy to tap and plan rows stay readable', JSON.stringify(walletLayout));
  const walletOverflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok(!walletOverflow, '390px customer Plans page has no horizontal overflow');
  await p.waitForFunction(() => document.querySelector('#toast')?.classList.contains('hidden'), null, { timeout: 5000 });
  await p.addStyleTag({ content: '.tabs{display:none!important}' }); await p.evaluate(() => window.scrollTo(0, 0));
  await p.screenshot({ path: `${OUT}/customer-plans-phone.png`, fullPage: true, animations: 'disabled' });
  await ctx.close(); }
// plan not listing the service cannot be forced through the API either
const forced = await call('/bookings', { method: 'POST', body: { barber_id: barberId, service_id: beard.id, date: (await call('/config')).j.today, time: '16:00', payment_option: 'PLAN', plan_purchase_id: (await call('/me/wallet', {}, cust)).j.plans[0].id } }, cust);
ok(forced.r.status === 409, 'server refuses a plan session for a service the plan does not include', forced.r.status + JSON.stringify(forced.j));
// barber view: roomy plan editor, collapsed operational sections, and live metrics
{ const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', baseURL: BASE });
  await ctx.addInitScript(() => { try { localStorage.setItem('trimslot_theme', 'dark'); } catch {} });
  await ctx.addCookies([{ name: mike.split('=')[0], value: mike.split('=').slice(1).join('='), url: BASE }]);
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); await p.goto('/#/plans'); await p.waitForSelector('.plan-live-summary'); await p.waitForSelector('.plnline');
  const t = await p.evaluate(() => document.querySelector('#app').innerText);
  ok(/Includes .*Kids Haircut/.test(t), 'barber plan list shows included services');
  ok(await p.locator('#barber-offers').evaluate((e) => e.open), 'barber offers are the primary open section');
  ok(!(await p.locator('#barber-create').evaluate((e) => e.open)), 'barber plan-creation form is collapsed by default');
  ok(!(await p.locator('#barber-purchases').evaluate((e) => e.open)), 'barber purchases are collapsed by default');
  ok(!(await p.locator('#barber-credits').evaluate((e) => e.open)) && !(await p.locator('#barber-rules').evaluate((e) => e.open)), 'barber credits and rules stay collapsed by default');
  ok(/Add a plan/.test(await p.locator('#barber-create > summary').innerText()) && /Rules & refunds/.test(await p.locator('#barber-rules > summary').innerText()), 'secondary disclosure labels are concise');
  ok(Number(await p.locator('[data-plan-counter="barber-sessions"]').innerText()) > 0, 'barber live counter shows sessions remaining');
  const refreshButton = p.locator('.plan-refresh-info'), refreshNote = p.locator('#barber-refresh-note');
  ok(!(await refreshNote.isVisible()) && await refreshButton.getAttribute('aria-expanded') === 'false', 'refresh note is hidden until requested');
  await refreshButton.click();
  ok(await refreshNote.isVisible() && /10 seconds/i.test(await refreshNote.innerText()) && await refreshButton.getAttribute('aria-expanded') === 'true', 'info button reveals the 10-second refresh note');
  await refreshButton.click();
  ok(!(await refreshNote.isVisible()) && await refreshButton.getAttribute('aria-expanded') === 'false', 'refresh note closes with the same info button');
  const chevrons = await p.evaluate(() => [...document.querySelectorAll('.barber-plans-view details > summary')].map((s) => getComputedStyle(s, '::before').transitionDuration));
  const chevronState = await p.evaluate(() => ({ open: getComputedStyle(document.querySelector('#barber-offers > summary'), '::before').transform, closed: getComputedStyle(document.querySelector('#barber-purchases > summary'), '::before').transform }));
  ok(chevrons.length >= 5 && chevrons.every((duration) => Number.parseFloat(duration) > 0) && chevronState.open !== chevronState.closed, 'all barber Plans dropdowns share a smooth chevron transition');
  const barberLayout = await p.evaluate(() => {
    const summary = document.querySelector('.plan-live-summary'), metric = document.querySelector('.barber-plan-offers'), header = document.querySelector('#barber-offers > summary'), card = document.querySelector('.plan-offer-card'), metrics = document.querySelector('.barber-plan-metrics');
    const sessions = document.querySelector('.barber-plan-sessions').getBoundingClientRect(), purchases = document.querySelector('.barber-plan-purchases').getBoundingClientRect(), box = metrics.getBoundingClientRect();
    return { summaryHeight: summary.getBoundingClientRect().height, metricBorder: getComputedStyle(metric).borderTopWidth, headerHeight: header.getBoundingClientRect().height, cardPadding: parseFloat(getComputedStyle(card).paddingTop), sessionCenter: sessions.left + sessions.width / 2, purchaseCenter: purchases.left + purchases.width / 2, summaryCenter: box.left + box.width / 2, purchaseBelowSessions: purchases.top >= sessions.bottom - 1 };
  });
  ok(barberLayout.summaryHeight <= 155 && barberLayout.metricBorder === '0px', '390px barber live summary is compact, with no oversized metric tiles', JSON.stringify(barberLayout));
  ok(barberLayout.headerHeight >= 44 && barberLayout.headerHeight <= 58 && barberLayout.cardPadding >= 9 && barberLayout.cardPadding <= 11, 'barber offer cards are compact while disclosure controls remain easy to tap', JSON.stringify(barberLayout));
  ok(Math.abs(barberLayout.sessionCenter - barberLayout.summaryCenter) <= 2 && Math.abs(barberLayout.purchaseCenter - barberLayout.summaryCenter) <= 2 && barberLayout.purchaseBelowSessions, 'session total and active purchases share the centered vertical axis');
  const card = p.locator('.plan-offer-card').first(), manage = card.locator('.plan-manage'), stats = card.locator('.plan-stats');
  const offerColumns = await card.locator('.plan-offer-main').evaluate((row) => {
    const rect = (selector) => { const r = row.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right }; };
    return { info: rect('.plan-offer-info'), status: rect('.plan-offer-status'), actions: rect('.plan-offer-actions') };
  });
  ok(offerColumns.info.right <= offerColumns.status.left + 1 && offerColumns.status.right <= offerColumns.actions.left + 1, 'plan details, status/purchases, and actions form left-middle-right columns', JSON.stringify(offerColumns));
  await manage.click();
  ok(await stats.evaluate((e) => e.open) && await manage.getAttribute('aria-expanded') === 'true' && await card.locator('.plan-stats .del').count() > 0, 'Manage opens performance details and retains stop-selling action');
  await manage.click();
  const editButton = card.locator('.ed'); await editButton.click();
  ok(await card.evaluate((e) => e.classList.contains('editing')) && await editButton.getAttribute('aria-expanded') === 'true', 'Edit opens the existing plan editor accessibly');
  await editButton.click();
  const planOverflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok(!planOverflow, '390px barber Plans page has no horizontal overflow');
  await p.setViewportSize({ width: 360, height: 844 }); await p.waitForTimeout(100);
  ok(!(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), '360px barber Plans page has no horizontal overflow');
  await p.setViewportSize({ width: 390, height: 844 }); await p.addStyleTag({ content: '.tabs{display:none!important}' }); await p.evaluate(() => window.scrollTo(0, 0));
  await refreshButton.click(); await p.evaluate(() => window.scrollTo(0, 0));
  await p.screenshot({ path: `${OUT}/barber-plans-refresh-info-phone.png`, fullPage: true, animations: 'disabled' });
  await refreshButton.click(); await manage.click(); await p.evaluate(() => window.scrollTo(0, 0));
  await p.screenshot({ path: `${OUT}/barber-plans-manage-phone.png`, fullPage: true, animations: 'disabled' });
  await manage.click();
  await p.screenshot({ path: `${OUT}/barber-plans-phone.png`, fullPage: true, animations: 'disabled' });
  await p.locator('#barber-create > summary').click();
  ok(/only book the services you tick/i.test(await p.locator('#barber-create').innerText()), 'create form remains available inside its disclosure');
  await p.screenshot({ path: `${OUT}/barber-plans-add-plan-phone.png`, fullPage: true, animations: 'disabled' });
  await p.locator('#barber-create > summary').click();
  await p.locator('#barber-purchases > summary').click(); await p.waitForSelector('#barber-purchases table.plan-table');
  ok(await p.locator('#barber-purchases table.plan-table tbody tr').count() > 0, 'barber purchase table expands on demand');
  const purchaseRow = await p.locator('#barber-purchases table.plan-table tbody td').first().evaluate((e) => ({ font: parseFloat(getComputedStyle(e).fontSize), padding: parseFloat(getComputedStyle(e).paddingTop), label: e.dataset.label }));
  ok(purchaseRow.font >= 12 && purchaseRow.padding >= 5 && purchaseRow.label === 'Customer', 'expanded barber purchase row keeps readable text and its phone label', JSON.stringify(purchaseRow));
  await p.evaluate(() => window.scrollTo(0, 0)); await p.screenshot({ path: `${OUT}/barber-plans-purchases-phone.png`, fullPage: true, animations: 'disabled' });
  await p.locator('#barber-purchases > summary').click();
  await p.locator('#barber-credits > summary').click(); await p.waitForTimeout(100); await p.evaluate(() => window.scrollTo(0, 0));
  await p.screenshot({ path: `${OUT}/barber-plans-credits-phone.png`, fullPage: true, animations: 'disabled' });
  await p.locator('#barber-credits > summary').click();
  await p.locator('#barber-rules > summary').click(); await p.waitForTimeout(100); await p.evaluate(() => window.scrollTo(0, 0));
  await p.screenshot({ path: `${OUT}/barber-plans-rules-phone.png`, fullPage: true, animations: 'disabled' });
  await p.locator('#barber-rules > summary').click();
  await p.goto('/#/settings'); await p.waitForSelector('.acc[data-k="hours"]');
  if (!(await p.locator('.acc[data-k="hours"]').evaluate((e) => e.open))) await p.locator('.acc[data-k="hours"] > summary').click();
  await p.waitForSelector('.dayrow:not(.off) .times input[type="time"]');
  const timeLayout = await p.evaluate(() => [...document.querySelectorAll('.dayrow:not(.off) .times')].map((group) => {
    const g = group.getBoundingClientRect();
    const boxes = [...group.querySelectorAll('input[type="time"]')].map((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; }).filter((r) => r.width && r.height);
    return { left: g.left, right: g.right, boxes };
  }));
  const timeBoxes = timeLayout.flatMap((g) => g.boxes);
  let overlaps = false, outside = false;
  for (const group of timeLayout) for (const box of group.boxes) {
    if (box.left < group.left - 1 || box.right > group.right + 1) outside = true;
    for (const other of group.boxes) if (box !== other && box.left < other.right - 1 && box.right > other.left + 1 && box.top < other.bottom - 1 && box.bottom > other.top + 1) overlaps = true;
  }
  ok(timeBoxes.length >= 4, 'barber hours include visible time fields to check');
  ok(!outside && !overlaps, '390px barber opening and break time boxes stay inside their cells without overlap');
  await ctx.close(); }
ok(errs.length === 0, 'no page errors', errs.join(' | '));
await b.close();
console.log(`${total - fails}/${total} plan-fit and Plans UI checks passed`);
process.exit(fails ? 1 : 0);
