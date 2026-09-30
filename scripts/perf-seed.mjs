// LOCAL ONLY. Seeds the embedded dev DB with 5,000 customers, 100 barbers and 50,000 bookings (+ payments, reviews, notifications, audit rows) using set-based SQL.
import pg from '/workspace/trimslot/node_modules/pg/lib/index.js';
const url = 'postgres://postgres:postgres@127.0.0.1:54320/trimslot';
const c = new pg.Client({ connectionString: url }); await c.connect();
const t0 = Date.now();
await c.query(`DELETE FROM users WHERE email LIKE 'perf%@perf.test'`).catch(() => {});
await c.query(`INSERT INTO users (role,name,email,phone,password_hash,created_at,account_status,warn_count)
  SELECT 'customer', (ARRAY['Chidi','Tunde','Amaka','Ngozi','Emeka','Bola','Sade','Kunle','Ife','Zainab'])[1+g%10] || ' ' || (ARRAY['Okafor','Adeyemi','Eze','Bello','Nwosu','Ibrahim','Balogun','Obi','Lawal','Musa'])[1+(g/10)%10] || ' ' || g,
    'perf' || g || '@perf.test', '080' || lpad(g::text, 8, '0'), 'x', now() - (g || ' minutes')::interval,
    CASE WHEN g%97=0 THEN 'SUSPENDED' WHEN g%501=0 THEN 'BANNED' ELSE 'ACTIVE' END, CASE WHEN g%13=0 THEN 1 ELSE 0 END FROM generate_series(1,5000) g`);
await c.query(`INSERT INTO users (role,name,email,phone,password_hash) SELECT 'barber','Perf Barber '||g,'perfb'||g||'@perf.test','081'||lpad(g::text,8,'0'),'x' FROM generate_series(1,100) g`);
await c.query(`INSERT INTO barbers (user_id,shop_name,location,verified,review_status,created_at) SELECT id,'Perf Shop '||substr(email,6),'Lagos',TRUE,(ARRAY['VERIFIED','VERIFIED','PENDING','SUSPENDED'])[1+id%4],now() FROM users WHERE email LIKE 'perfb%@perf.test'`);
await c.query(`INSERT INTO services (barber_id,name,price_kobo,duration_min) SELECT b.id, s.n, s.p, s.d FROM barbers b, (VALUES ('Haircut',300000,30),('Beard trim',200000,20),('Cut + beard',450000,45)) s(n,p,d) WHERE b.shop_name LIKE 'Perf Shop%'`);
const cu = (await c.query(`SELECT min(id) lo, max(id) hi FROM users WHERE email LIKE 'perf%@perf.test' AND role='customer'`)).rows[0];
await c.query(`ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_no_overlap`);
await c.query(`DROP INDEX IF EXISTS uq_bookings_active_slot`);
await c.query(`WITH b AS (SELECT array_agg(id ORDER BY id) ids FROM barbers WHERE shop_name LIKE 'Perf Shop%'), sv AS (SELECT barber_id, array_agg(id ORDER BY id) sids FROM services WHERE name IN ('Haircut','Beard trim','Cut + beard') GROUP BY barber_id)
  INSERT INTO bookings (customer_id,barber_id,service_id,scheduled_at,ends_at,service_name,price_kobo,duration_min,status,payment_option,payment_status,created_at)
  SELECT $1 + (g*7919) % 5000, bid, (SELECT sids[1+g%3] FROM sv WHERE sv.barber_id=bid), ts, ts + interval '30 minutes', 'Haircut', 300000, 30,
    (ARRAY['COMPLETED','COMPLETED','COMPLETED','CONFIRMED','CANCELLED','NO_SHOW'])[1+g%6], (ARRAY['ONLINE','ON_ARRIVAL'])[1+g%2],
    CASE WHEN g%6 IN (0,1,2) THEN 'PAID' WHEN g%6=3 THEN 'PAYMENT_DUE' ELSE 'VOID' END, ts - interval '2 days'
  FROM (SELECT g, (SELECT ids[1+g%100] FROM b) bid, timestamptz '2026-09-30 09:00+01' + ((g % 240) - 200) * interval '1 day' + (g % 9) * interval '1 hour' + (g/240 % 2) * interval '30 minutes' AS ts FROM generate_series(1,50000) g) x`, [cu.lo]);
await c.query(`INSERT INTO payments (booking_id,reference,provider,amount_kobo,fee_kobo,status,created_at,verified_at,barber_id,refund_status,disputed)
  SELECT id,'TS-PERF-'||id||'-x','MOCK',price_kobo,30000,'SUCCESS',created_at,created_at,barber_id,CASE WHEN id%400=0 THEN 'NEEDS_REFUND' END, id%997=0 FROM bookings WHERE payment_status='PAID' AND payment_option='ONLINE'`);
await c.query(`INSERT INTO reviews (booking_id,barber_id,customer_id,rating,comment,created_at) SELECT id,barber_id,customer_id,1+id%5,'Perf review '||id,now() FROM bookings WHERE status='COMPLETED' AND id%5=0`);
await c.query(`INSERT INTO notifications (user_id,type,title,body,is_read,created_at,pushed_at) SELECT customer_id,'X','Perf','Perf body',id%3=0,now(),now() FROM bookings WHERE id%2=0`);
await c.query(`INSERT INTO audit_log (booking_id,actor_role,action,details) SELECT NULL,(ARRAY['admin','system','customer'])[1+g%3],(ARRAY['ADMIN_WARN','BOOKING_CANCELLED','PAYMENT_OK'])[1+g%3],'{}'::jsonb FROM generate_series(1,30000) g`).catch((e) => console.log('audit skip', e.message));
await c.query('ANALYZE');
const n = (await c.query(`SELECT (SELECT count(*) FROM users WHERE role='customer') customers,(SELECT count(*) FROM bookings) bookings,(SELECT count(*) FROM payments) payments`)).rows[0];
console.log('seeded in', Date.now() - t0, 'ms', n);
await c.end();
