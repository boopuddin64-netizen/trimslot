// Seeds a LOCAL mock-mode server (port 4102) for the admin-power screenshots: off-app ledger, netting, report, suspended customer, pause, fee override, broadcast.
import pg from '/workspace/trimslot/node_modules/pg/lib/index.js';
const B = process.env.BASE || 'http://localhost:4102', KEY = process.env.KEY || 'local-admin-key-xyz';
if (!B.includes('localhost')) throw new Error('local only');
const call = async (p, o = {}, cookie) => { const r = await fetch(B + '/api' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(o.auth ? { Authorization: 'Bearer ' + KEY } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); const j = await r.json().catch(() => ({})); if (r.status >= 400) console.log('WARN', p, r.status, JSON.stringify(j).slice(0, 140)); return { r, j }; };
const login = async (id, pw) => (await call('/auth/login', { method: 'POST', body: { identifier: id, password: pw } })).r.headers.get('set-cookie').split(';')[0];
const c = new pg.Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:54320/trimslot' }); await c.connect();
await c.query(`UPDATE barbers SET paystack_subaccount='ACCT_demo' WHERE id=1`);
await call('/admin/settings', { method: 'PUT', auth: true, body: { charge_percent: 10, charge_min_naira: 0, commission_factor: 0.5 } });
const chidi = await login('chidi@trimslot.demo', 'Customer123!'); const tunde = await login('tunde@trimslot.demo', 'Customer123!'); const mike = await login('mike@trimslot.demo', 'Barber123!');
const svcs = (await call('/barbers/1', {}, chidi)).j.services;
const off = async (time, ck, svc = 0) => {
  const b = (await call('/bookings', { method: 'POST', body: { barber_id: 1, service_id: svcs[svc].id, date: '2026-09-30', time, payment_option: 'ON_ARRIVAL' } }, ck)).j.booking.id;
  for (const a of ['mark-present', 'start']) await call(`/barber/bookings/${b}/${a}`, { method: 'POST', body: {} }, mike);
  await call(`/barber/bookings/${b}/record-payment`, { method: 'POST', body: { method: 'cash' } }, mike);
  await call(`/barber/bookings/${b}/complete`, { method: 'POST', body: {} }, mike); return b;
};
const b1 = await off('10:30', chidi); const b2 = await off('11:30', tunde, 1); const b3 = await off('16:00', chidi, 3);
// one online payment afterwards: nets part of the debt
const ob = (await call('/bookings', { method: 'POST', body: { barber_id: 1, service_id: svcs[0].id, date: '2026-10-02', time: '10:00', payment_option: 'ONLINE' } }, tunde)).j.booking.id;
const p = (await call(`/bookings/${ob}/pay`, { method: 'POST', body: {} }, tunde)).j; await call(`/payments/mock/${p.reference}/complete`, { method: 'POST', body: {} }); await call(`/payments/callback?reference=${p.reference}`);
// a fresh debt on top
await c.query(`INSERT INTO commission_ledger (barber_id, kind, amount_kobo, remaining_kobo, note, created_at) VALUES (1,'ADJUSTMENT',25000,25000,'Late fee (demo)', now())`);
// report from a customer, suspended customer, broadcast
const bk = (await call('/bookings', { method: 'POST', body: { barber_id: 1, service_id: svcs[0].id, date: '2026-10-03', time: '10:00', payment_option: 'ON_ARRIVAL' } }, chidi)).j.booking.id;
await call('/reports', { method: 'POST', body: { category: 'BEHAVIOUR', message: 'The barber was 40 minutes late and did not apologise.', booking_id: bk } }, chidi);
await call('/reports', { method: 'POST', body: { category: 'NO_SHOW', message: 'Customer never showed up and did not answer calls.', booking_id: bk } }, mike);
const uid = (await c.query(`SELECT id FROM users WHERE email='tunde@trimslot.demo'`)).rows[0].id;
await call(`/admin/users/${uid}/warn`, { method: 'POST', auth: true, body: { reason: 'Please arrive on time.' } });
const extra = await call('/auth/signup', { method: 'POST', body: { accept_terms: true, role: 'customer', name: 'Amaka Eze', email: 'amaka@trimslot.demo', password: 'Customer123!' } });
const aid = (await c.query(`SELECT id FROM users WHERE email='amaka@trimslot.demo'`)).rows[0].id;
await call(`/admin/users/${aid}/suspend`, { method: 'POST', auth: true, body: { reason: 'Three no-shows in a row.' } });
await call('/admin/broadcast', { method: 'POST', auth: true, body: { audience: 'customers', title: 'Holiday hours', body: 'Most shops are closed on Friday for the public holiday.' } });
await call('/admin/barbers/1/fee', { method: 'POST', auth: true, body: { percent: 8, reason: 'Founding partner rate' } });
await c.end(); console.log('power seeded', { b1, b2, b3, ob });
