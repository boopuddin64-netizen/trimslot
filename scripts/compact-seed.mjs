// LOCAL ONLY: adds volume to the local mock DB (port 54320) so list density can be measured: customers, barbers, bookings, plan purchases, credits, reports, reviews, waitlist, payments.
import pg from '/workspace/trimslot/node_modules/pg/lib/index.js';
const c = new pg.Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:54320/trimslot' }); await c.connect();
const ph = (await c.query(`SELECT password_hash FROM users WHERE email='chidi@trimslot.demo'`)).rows[0].password_hash;
const names = ['Adaeze Okonkwo-Williams', 'Babatunde Adeyemi', 'Chinedu Eze', 'Damilola Ogunleye', 'Emeka Nwosu', 'Funmilayo Adebayo', 'Ibrahim Musa', 'Jumoke Balogun', 'Kelechi Obi', 'Latifat Yusuf'];
const cust = [];
for (const [i, n] of names.entries()) { const r = await c.query(`INSERT INTO users (role,name,email,phone,password_hash,account_status,warn_count) VALUES ('customer',$1,$2,$3,$4,$5,$6) ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [n, `${n.toLowerCase().replace(/[^a-z]/g, '.')}.compact${i}@trimslot-demo-example.com`, '0803000' + String(1000 + i), ph, i === 3 ? 'SUSPENDED' : 'ACTIVE', i % 4 === 1 ? 1 : 0]); cust.push(r.rows[0].id); }
const shops = [['Fade Factory Barbershop & Grooming Lounge', 'Lekki Phase 1, Lagos', 'PENDING'], ['Crown Cuts', 'Wuse 2, Abuja', 'NEEDS_INFO'], ['The Gentlemen\'s Cave', 'GRA, Port Harcourt', 'VERIFIED'], ['Sharp Edge', 'Yaba, Lagos', 'SUSPENDED'], ['Clippers Corner', 'Bodija, Ibadan', 'REJECTED'], ['Royal Trim', 'Ikeja, Lagos', 'PENDING']];
const bids = [1];
for (const [i, [s, loc, st]] of shops.entries()) {
  const u = await c.query(`INSERT INTO users (role,name,email,phone,password_hash) VALUES ('barber',$1,$2,$3,$4) ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name RETURNING id`, ['Owner Of ' + s.split(' ')[0], `owner.of.${s.toLowerCase().replace(/[^a-z]/g, '')}.long.address${i}@trimslot-demo-example.com`, '0805000' + (1000 + i), ph]);
  const ex = await c.query(`SELECT id FROM barbers WHERE user_id=$1`, [u.rows[0].id]);
  const b = ex.rows[0] || (await c.query(`INSERT INTO barbers (user_id,shop_name,location,review_status,verified) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [u.rows[0].id, s, loc, st, st === 'VERIFIED'])).rows[0];
  bids.push(b.id);
}
const stat = [['CONFIRMED', 'PAID'], ['COMPLETED', 'PAID'], ['CANCELLED', 'VOID'], ['NO_SHOW', 'CREDITED'], ['PENDING_PAYMENT', 'PENDING'], ['ARRIVED', 'PAYMENT_DUE'], ['CONFIRMED', 'PAYMENT_DUE'], ['CANCELLED', 'CREDIT_PENDING'], ['COMPLETED', 'PAYMENT_DUE']];
const svc = (await c.query(`SELECT id,name,price_kobo,duration_min FROM services WHERE barber_id=1 ORDER BY id`)).rows;
const bks = [];
for (let i = 0; i < 28; i++) {
  const s = svc[i % svc.length], [st, ps] = stat[i % stat.length], day = 20 + (i % 14), mins = 9 * 60 + (i % 9) * 40;
  const d = `2026-${day > 30 ? '10' : '09'}-${String(day > 30 ? day - 30 : day).padStart(2, '0')}`;
  const r = await c.query(`INSERT INTO bookings (customer_id,barber_id,service_id,scheduled_at,ends_at,service_name,price_kobo,duration_min,status,payment_option,payment_status) VALUES ($1,1,$2,($3::date + $4 * interval '1 minute') AT TIME ZONE 'Africa/Lagos',($3::date + $5 * interval '1 minute') AT TIME ZONE 'Africa/Lagos',$6,$7,$8,$9,$10,$11) RETURNING id`, [cust[i % cust.length], s.id, d, mins, mins + s.duration_min, s.name, s.price_kobo, s.duration_min, st, ps === 'PAID' ? 'ONLINE' : 'ON_ARRIVAL', ps]);
  bks.push(r.rows[0].id);
}
const plan = (await c.query(`SELECT id,name,price_kobo,sessions,validity_days FROM plans LIMIT 1`)).rows[0];
if (plan) for (let i = 0; i < 9; i++) await c.query(`INSERT INTO plan_purchases (plan_id,customer_id,barber_id,plan_name,price_kobo,sessions_total,sessions_used,validity_days,service_ids,status,paid_at,expires_at) VALUES ($1,$2,1,$3,$4,$5,$6,$7,'{1,2}',$8,now(),now() + ($9 * interval '1 day'))`, [plan.id, cust[i % cust.length], plan.name, plan.price_kobo, plan.sessions, i % (plan.sessions + 1), plan.validity_days, i === 5 ? 'CANCELLED' : 'ACTIVE', 20 - i * 4]);
for (let i = 0; i < 7; i++) await c.query(`INSERT INTO session_credits (customer_id,barber_id,source_booking_id,reason,value_kobo,status,expires_at) VALUES ($1,1,$2,$3,$4,$5,now() + ($6 * interval '1 day'))`, [cust[i % cust.length], bks[i], ['NO_SHOW', 'LATE_CANCEL', 'EARLY_CANCEL', 'LOYALTY'][i % 4], 300000 + i * 50000, i === 4 ? 'USED' : i === 6 ? 'REVOKED' : 'AVAILABLE', 25 - i * 5]);
const cats = ['NO_SHOW', 'BEHAVIOUR', 'PAYMENT', 'QUALITY', 'SAFETY', 'OTHER'];
for (let i = 0; i < 7; i++) await c.query(`INSERT INTO reports (reporter_id,target_user_id,booking_id,category,message,status) VALUES ($1,$2,$3,$4,$5,$6)`, [cust[i], cust[(i + 3) % cust.length], bks[i], cats[i % 6], 'The appointment started 40 minutes late and nobody explained why, and the price quoted on the app was not the price charged at the end.', i < 5 ? 'OPEN' : 'RESOLVED']);
const done = bks.slice(0, 28).filter((_, i) => stat[i % stat.length][0] === 'COMPLETED');
for (const [i, id] of done.entries()) { const bk = (await c.query(`SELECT customer_id FROM bookings WHERE id=$1`, [id])).rows[0]; await c.query(`INSERT INTO reviews (booking_id,customer_id,barber_id,rating,comment,hidden) VALUES ($1,$2,1,$3,$4,$5) ON CONFLICT DO NOTHING`, [id, bk.customer_id, 1 + (i % 5), i % 2 ? 'Great cut, friendly and on time. Would recommend to anyone looking for a clean fade.' : '', i === 2]); }
for (let i = 0; i < 6; i++) await c.query(`INSERT INTO waitlist (customer_id,barber_id,service_id,date,status) VALUES ($1,1,$2,'2026-10-02',$3)`, [cust[i], svc[i % 4].id, ['WAITING', 'NOTIFIED', 'WAITING', 'BOOKED', 'EXPIRED', 'WAITING'][i]]);
console.log('compact seed ok', { cust: cust.length, bks: bks.length });
await c.end();
