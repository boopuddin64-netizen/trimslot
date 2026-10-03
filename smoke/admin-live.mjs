// Live admin smoke test. Needs CRON_SECRET in env (never printed). Creates only smoketest+adm-*@example.com throwaway accounts and never touches real users.
// Does NOT flip global maintenance / feature switches (those are covered by unit tests + local runs).
const B = process.env.BASE || 'https://trimslot-eight.vercel.app', KEY = process.env.CRON_SECRET; if (!KEY) throw new Error('CRON_SECRET missing');
const tag = Date.now().toString(36);
const call = async (p, o = {}, ck) => { const r = await fetch(B + '/api' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(ck ? { Cookie: ck } : {}), ...(o.auth ? { Authorization: 'Bearer ' + KEY, ...(process.env.SMOKE_PIN ? { 'X-Admin-Pin': process.env.SMOKE_PIN } : {}) } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); const j = await r.json().catch(() => ({})); return { s: r.status, j, r }; };
const A = (p, o = {}) => call(p, { ...o, auth: true });
const P = (p, body) => A(p, { method: 'POST', body: body || {} });
let bad = 0; const ck = (ok, m) => { if (!ok) bad++; console.log((ok ? 'ok   ' : 'FAIL ') + m); };
const bEmail = `smoketest+adm-b-${tag}@example.com`, cEmail = `smoketest+adm-c-${tag}@example.com`, c2Email = `smoketest+adm-d-${tag}@example.com`;
const sb = await call('/auth/signup', { method: 'POST', body: { role: 'barber', name: 'Admin Smoke Barber', email: bEmail, password: 'Smoke12345!', shop_name: 'Admin Smoke Shop', location: 'Test' } });
const sc = await call('/auth/signup', { method: 'POST', body: { role: 'customer', name: 'Admin Smoke Cust', email: cEmail, password: 'Smoke12345!' } });
const sd = await call('/auth/signup', { method: 'POST', body: { role: 'customer', name: 'Admin Smoke Cust Two', email: c2Email, password: 'Smoke12345!' } });
ck(sb.s === 201 && sc.s === 201 && sd.s === 201, 'signup throwaway barber + 2 customers ' + [sb.s, sc.s, sd.s]);
const bck = sb.r.headers.get('set-cookie').split(';')[0], cck = sc.r.headers.get('set-cookie').split(';')[0], dck = sd.r.headers.get('set-cookie').split(';')[0];
const svc = await call('/barber/services', { method: 'POST', body: { name: 'Smoke cut', price_naira: 3000, duration_min: 30 } }, bck); ck(svc.s < 300, 'barber adds a service ' + svc.s);
const sid = svc.j.id ?? svc.j.service?.id;
const ov = await A('/admin/overview'); ck(ov.s === 200 && typeof ov.j.reports_open === 'number' && typeof ov.j.ledger_owed_kobo === 'number', `overview ok (pending=${ov.j.barbers_pending}, reports_open=${ov.j.reports_open}, maintenance=${ov.j.maintenance_mode})`);
const cfg0 = (await call('/config')).j; ck(cfg0.maintenance === null && cfg0.features?.plans === true, 'public config: no maintenance, features exposed');
const bl = await A('/admin/barbers'); const mine = bl.j.barbers.find((x) => x.email === bEmail); ck(!!mine && mine.review_status === 'PENDING', 'throwaway barber is PENDING');
const id = mine.id; if (id === 2) throw new Error('refusing to touch barber 2'); const buid = mine.user_id;
// ---- review workflow
ck((await P(`/admin/barbers/${id}/request-info`, {})).s === 400, 'request-info without message -> 400');
ck((await P(`/admin/barbers/${id}/request-info`, { message: 'Please add a shop photo (smoke test)' })).j.review_status === 'NEEDS_INFO', 'request-info');
ck((await call('/auth/me', {}, bck)).j.user.review_status === 'NEEDS_INFO', 'barber sees NEEDS_INFO');
ck((await call('/barber/resubmit', { method: 'POST', body: {} }, bck)).j.review_status === 'PENDING', 'barber resubmits');
ck((await P(`/admin/barbers/${id}/reject`, { reason: 'Smoke test rejection' })).j.review_status === 'REJECTED', 'reject with reason');
ck((await call('/barber/resubmit', { method: 'POST', body: {} }, bck)).j.review_status === 'PENDING', 'resubmit after rejection');
ck((await P(`/admin/barbers/${id}/approve`)).j.verified === true, 'approve -> verified');
ck((await call('/barbers')).j.barbers.some((b) => b.id === id), 'verified shop visible to customers');
ck((await P(`/admin/barbers/${id}/suspend`, {})).s === 400, 'suspend needs a reason');
ck((await P(`/admin/barbers/${id}/suspend`, { reason: 'Smoke suspension', bookings: 'keep' })).j.review_status === 'SUSPENDED', 'suspend');
ck((await call('/barbers')).j.barbers.every((b) => b.id !== id), 'suspended shop hidden');
ck((await P(`/admin/barbers/${id}/reinstate`)).j.review_status === 'VERIFIED', 'reinstate');
// ---- per-barber controls
ck((await P(`/admin/barbers/${id}/pause`, { paused: true })).s === 400, 'pause needs a reason');
ck((await P(`/admin/barbers/${id}/pause`, { paused: true, reason: 'smoke' })).j.changed === true, 'pause bookings');
const d = (() => { let t = Date.now() + 86400000 + 3600000; if (new Date(t).getUTCDay() === 0) t += 86400000; return new Date(t).toISOString().slice(0, 10); })(); // never a Sunday (default schedule is closed)
const paused = await call('/bookings', { method: 'POST', body: { barber_id: id, service_id: sid, date: d, time: '10:00', payment_option: 'ON_ARRIVAL' } }, cck); ck(paused.s === 409 && paused.j.error?.code === 'BARBER_PAUSED', 'booking blocked while paused ' + paused.s);
ck((await call(`/barbers/${id}`)).j.booking?.paused === true, 'barber page exposes paused flag');
ck((await P(`/admin/barbers/${id}/pause`, { paused: false })).j.changed === true, 'resume bookings');
ck((await P(`/admin/barbers/${id}/fee`, { percent: 5, flat_naira: 0, reason: 'smoke' })).j.override === true, 'fee override set'); ck((await P(`/admin/barbers/${id}/fee`, {})).j.override === false, 'fee override cleared');
// ---- bookings: reschedule, cancel, online payment init
const mk = async (ck2, time, opt) => call('/bookings', { method: 'POST', body: { barber_id: id, service_id: sid, date: d, time, payment_option: opt } }, ck2);
const b1 = await mk(cck, '10:00', 'ON_ARRIVAL'); ck(b1.s === 201, 'customer books pay-on-arrival ' + b1.s); const bid1 = b1.j.booking?.id;
const blk = await mk(dck, '12:00', 'ONLINE'); ck(blk.s === 409 && blk.j.error?.code === 'PAYOUT_NOT_SETUP', 'online payment refused until the barber has payouts ' + blk.s);
const b2 = await mk(dck, '12:00', 'ON_ARRIVAL'); ck(b2.s === 201, 'customer 2 books pay-on-arrival ' + b2.s); const bid2 = b2.j.booking?.id;
const ref = 'TS-SMOKE-NONE-' + tag; // real payment init is covered by smoke/pay-live.mjs
ck((await P(`/admin/bookings/${bid1}/reschedule`, { date: d, time: '11:00' })).s === 400, 'reschedule needs a reason');
const mv = await P(`/admin/bookings/${bid1}/reschedule`, { date: d, time: '11:00', reason: 'smoke test move' }); ck(mv.s === 200, 'admin reschedules ' + mv.s + ' ' + JSON.stringify(mv.j).slice(0, 100));
ck((await call('/notifications', {}, cck)).j.notifications.some((n) => n.type === 'BOOKING_RESCHEDULED'), 'customer notified of the move');
ck((await call('/notifications', {}, bck)).j.notifications.some((n) => n.type === 'BOOKING_RESCHEDULED'), 'barber notified of the move');
const bd = await A('/admin/bookings/' + bid1); ck(bd.s === 200 && bd.j.booking.id === bid1, 'booking detail');
// ---- off-app ledger: admin force-complete with paid -> commission accrues (fee base: platform settings)
const cp = await P(`/admin/bookings/${bid1}/complete`, { reason: 'smoke force complete', paid: true }); ck(cp.s === 200 && cp.j.status === 'COMPLETED', 'force-complete pay-on-arrival ' + cp.s + ' ledger_id=' + cp.j.ledger_id);
const led = await A('/admin/ledger/' + id); ck(led.s === 200, 'ledger detail');
const owed = led.j.balance.outstanding_kobo; ck(cp.j.ledger_id ? owed > 0 : true, 'commission accrued: owed_kobo=' + owed);
const mineL = await call('/barber/ledger', {}, bck); ck(mineL.s === 200 && mineL.j.owed_kobo === owed, 'barber sees Platform balance owed ' + mineL.j.owed_kobo);
if (owed > 0) {
  ck((await P(`/admin/ledger/${id}/adjust`, { amount_naira: 1, reason: 'smoke adjustment' })).j.owed_kobo === owed + 100, 'adjustment adds to the balance');
  ck((await P(`/admin/ledger/${id}/settle`, { amount_naira: 1, reason: 'smoke manual settle' })).j.owed_kobo === owed, 'manual settle reduces it');
  ck((await P(`/admin/ledger/remind`, { barber_id: id })).j.reminded === 1, 'reminder sent');
  ck((await call('/notifications', {}, bck)).j.notifications.some((n) => n.type === 'LEDGER_REMINDER'), 'barber got LEDGER_REMINDER');
  ck((await P(`/admin/ledger/${id}/waive`, { all: true, reason: 'smoke waive' })).j.owed_kobo === 0, 'waive all -> zero');
}
// ---- cancel with credit/refund options (customer 2's unpaid online booking: plain cancel)
ck((await P(`/admin/bookings/${bid2}/cancel`, {})).s === 400, 'cancel needs a reason'); ck((await P(`/admin/bookings/${bid2}/cancel`, { reason: 'smoke cancel' })).j.status === 'CANCELLED', 'admin cancels the booking');
// ---- customers: warn / suspend / ban / reinstate
const cl = await A('/admin/customers?q=' + encodeURIComponent(cEmail)); const cid = cl.j.customers[0]?.id; ck(cl.j.customers.length === 1 && cid > 4, 'customer search finds only the throwaway (id ' + cid + ')');
if (!cid || cid <= 4) throw new Error('unexpected customer id; refusing');
ck((await P(`/admin/users/${cid}/warn`, { reason: 'smoke warning' })).j.warn_count === 1, 'warn customer');
ck((await P(`/admin/users/${cid}/suspend`, { reason: 'smoke suspension' })).j.changed === true, 'suspend customer');
ck((await call('/auth/login', { method: 'POST', body: { identifier: cEmail, password: 'Smoke12345!' } })).s === 403, 'suspended customer cannot log in (403)');
ck((await call('/auth/me', {}, cck)).j.user == null, 'suspended customer session is ended');
ck((await P(`/admin/users/${cid}/ban`, { reason: 'smoke ban' })).j.account_status === 'BANNED', 'ban customer');
ck((await P(`/admin/users/${cid}/reinstate`)).j.changed === true, 'reinstate customer'); const relog = await call('/auth/login', { method: 'POST', body: { identifier: cEmail, password: 'Smoke12345!' } }); ck(relog.s === 200, 'reinstated customer logs in');
const cck2 = relog.r.headers.get('set-cookie').split(';')[0];
// ---- reports, broadcast (single throwaway user), credit issue/revoke
const rp = await call('/reports', { method: 'POST', body: { category: 'OTHER', message: 'Smoke test report', booking_id: bid1 } }, cck2); ck(rp.s === 201, 'customer files a report ' + rp.s);
const inbox = await A('/admin/reports'); const rid = inbox.j.reports.find((r) => r.booking_id === bid1)?.id; ck(!!rid, 'report in the admin inbox');
ck((await P(`/admin/reports/${rid}/resolve`, { status: 'RESOLVED', note: 'smoke resolved' })).j.status === 'RESOLVED', 'resolve report');
const bc = await P('/admin/broadcast', { audience: 'user', user_id: cid, title: 'Smoke broadcast', body: 'Only for the smoke test user.' }); ck(bc.j.recipients === 1, 'broadcast to ONE throwaway user');
ck((await call('/notifications', {}, cck2)).j.notifications.some((n) => n.type === 'ANNOUNCEMENT'), 'throwaway user got the announcement');
const ci = await P('/admin/credits/issue', { customer_id: cid, barber_id: id, value_naira: 1000, reason: 'smoke credit' }); ck(ci.s === 200, 'issue credit'); 
const credList = (await A('/admin/credits')).j.credits.find((c) => c.customer_id === cid); ck(!!credList, 'credit visible'); ck((await P(`/admin/credits/${credList.id}/revoke`, { reason: 'smoke revoke' })).j.changed === true, 'revoke credit');
// ---- money + analytics + search + audit + CSV
const en = await A('/admin/earnings'); ck(en.s === 200 && en.j.barbers.some((b) => b.id === id), 'earnings table');
ck((await P(`/admin/payments/${encodeURIComponent(ref)}/dispute`, { disputed: true })).s === 400, 'dispute needs a note');
const an = await A('/admin/analytics?days=7'); ck(an.s === 200 && an.j.series.length === 7, 'analytics 7d');
const se = await A('/admin/search?q=' + encodeURIComponent(`adm-c-${tag}`)); ck(se.s === 200 && se.j.users.length === 1, 'global search finds the throwaway customer');
const au = await A('/admin/audit?action=ADMIN_USER&scope=all'); ck(au.j.entries.length >= 4 && au.j.entries.every((e) => e.action.startsWith('ADMIN_USER')), 'audit filter by action');
const csv = await fetch(B + '/api/admin/export/barbers.csv', { headers: { Authorization: 'Bearer ' + KEY } }); const txt = await csv.text(); ck(csv.status === 200 && txt.startsWith('id,shop') && !txt.includes(KEY), 'CSV export works, no secret inside');
ck((await fetch(B + '/api/admin/export/bookings.csv')).status === 401, 'CSV needs the key');
for (const p of ['/admin/plans', '/admin/credits', '/admin/cancellations', '/admin/settings', '/admin/refunds', '/admin/payments?filter=needs_refund', '/admin/ledger', '/admin/broadcasts']) { const r = await A(p); ck(r.s === 200, p + ' ' + r.s); }
const set = (await A('/admin/settings')).j.settings; ck(set.commission_factor === 0.5 && set.commission_enabled === true && set.maintenance_mode === false, 'settings: factor 0.5, commission on, maintenance off');
ck((await call('/admin/login', { method: 'POST' })).s === 401, 'login without key 401'); ck((await A('/admin/login', { method: 'POST', body: {} })).s === 200, 'login with key 200');
console.log(JSON.stringify({ tag, barber_id: id, barber_user_id: buid, customer_id: cid, bookings: [bid1, bid2], ref })); console.log(bad ? bad + ' FAILED' : 'ALL OK'); process.exit(bad ? 1 : 0);
