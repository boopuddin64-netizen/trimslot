// Seeds a LOCAL mock-mode server (port 4102) with data for admin screenshots. Never run against production.
import pg from '/workspace/trimslot/node_modules/pg/lib/index.js';
const B = process.env.BASE || 'http://localhost:4102', KEY = process.env.KEY || 'local-admin-key-xyz';
if (!B.includes('localhost')) throw new Error('local only');
const call = async (p, o = {}, cookie) => { const r = await fetch(B + '/api' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(o.auth ? { Authorization: 'Bearer ' + KEY } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); const j = await r.json().catch(() => ({})); if (r.status >= 400) console.log('WARN', p, r.status, JSON.stringify(j).slice(0, 120)); return { r, j }; };
const login = async (id, pw) => (await call('/auth/login', { method: 'POST', body: { identifier: id, password: pw } })).r.headers.get('set-cookie').split(';')[0];
const chidi = await login('chidi@trimslot.demo', 'Customer123!'); const mike = await login('mike@trimslot.demo', 'Barber123!');
const svcs = (await call('/barbers/1', {}, chidi)).j.services;
const pay = async (bid, ck) => { const p = (await call(`/bookings/${bid}/pay`, { method: 'POST', body: {} }, ck)).j; const ref = p.reference; await call(`/payments/mock/${ref}/complete`, { method: 'POST', body: {} }); await call(`/payments/callback?reference=${ref}`); return ref; };
const mk = async (time, ck, date = '2026-10-01') => (await call('/bookings', { method: 'POST', body: { barber_id: 1, service_id: svcs[0].id, date, time, payment_option: 'ONLINE' } }, ck)).j.booking.id;
const b1 = await mk('10:00', chidi); await pay(b1, chidi);
const b2 = await mk('11:00', chidi); await pay(b2, chidi);
const b3 = await mk('12:00', chidi); const r3 = await pay(b3, chidi);
const b4 = await mk('14:00', chidi, '2026-09-30'); await pay(b4, chidi);
await call(`/bookings/${b1}/cancel`, { method: 'POST', body: {} }, chidi);
await call(`/bookings/${b2}/cancel`, { method: 'POST', body: {} }, chidi);
const b5 = await mk('15:00', chidi); await pay(b5, chidi); await call(`/bookings/${b5}/cancel`, { method: 'POST', body: {} }, chidi);
// resolve b2 as credit so Credits has a row; leave b1 and b5 pending
await call(`/admin/bookings/${b2}/resolve`, { method: 'POST', body: { action: 'credit' }, auth: true });
// plan + purchase
const plan = (await call('/barber/plans', { method: 'POST', body: { name: 'Monthly fresh (4 cuts)', price_naira: 12000, sessions: 4, validity_days: 30, service_ids: [svcs[0].id] } }, mike)).j.id;
const pp = (await call(`/plans/${plan}/buy`, { method: 'POST', body: {} }, chidi)).j; if (pp.reference) { await call(`/payments/mock/${pp.reference}/complete`, { method: 'POST', body: {} }); await call(`/payments/callback?reference=${pp.reference}`); }
// pending barber
await call('/auth/signup', { method: 'POST', body: { role: 'barber', name: 'Tunde Adebayo', email: 'tunde@sharpedge.demo', password: 'Barber123!', shop_name: 'Sharp Edge Studio', location: 'Lekki Phase 1, Lagos' } });
const c = new pg.Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:54320/trimslot' }); await c.connect();
await c.query(`UPDATE payments SET refund_status='NEEDS_REFUND', refund_reason='Paystack refund API timed out' WHERE reference=$1`, [r3]);
await c.query(`UPDATE payments SET status='FAILED' WHERE id=(SELECT id FROM payments WHERE status='INITIATED' ORDER BY id DESC LIMIT 1)`);
await c.end(); console.log('seeded');
