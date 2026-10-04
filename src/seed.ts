import bcrypt from 'bcryptjs';
import { Db } from './db';
import { isoNow } from './time';

export const DEMO = {
  barber: { email: 'mike@trimslot.demo', phone: '08031234567', password: 'Barber123!' },
  customers: [
    { name: 'Chidi Okafor', email: 'chidi@trimslot.demo', phone: '08055550001', password: 'Customer123!' },
    { name: 'Tunde Bakare', email: 'tunde@trimslot.demo', phone: '08055550002', password: 'Customer123!' },
  ],
};

export const DEMO_SHARE_CODE = 'de30c0de5a1e0001';
export async function seed(db: Db, rounds = 10) {
  const now = isoNow();
  return db.tx(async (t) => {
    const ins = 'INSERT INTO users (role, name, email, phone, password_hash, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id';
    const mike = (await t.one<{ id: number }>(ins, ['barber', 'Mike', DEMO.barber.email, DEMO.barber.phone, bcrypt.hashSync(DEMO.barber.password, rounds), now])).id;
    const barberId = (await t.one<{ id: number }>(
      'INSERT INTO barbers (user_id, shop_name, photo_url, location, about, paystack_subaccount, verified, verified_at, created_at) VALUES ($1,$2,$3,$4,$5,NULL,TRUE,$6,$6) RETURNING id',
      [mike, "Mike's Barbershop", 'https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=400&q=70',
        '12 Allen Avenue, Ikeja, Lagos', 'Sharp fades, clean beards, zero stress. 10+ years behind the chair. Walk in fresh, walk out fresher.', now])).id;
    for (let wd = 0; wd < 7; wd++) { // Mon-Sat 09:00-18:00, break 13:00-14:00
      await t.query('INSERT INTO barber_schedule (barber_id, weekday, is_working, start_min, end_min, break_start_min, break_end_min) VALUES ($1,$2,$3,540,1080,780,840)', [barberId, wd, wd >= 1 && wd <= 6]);
    }
    for (const [name, price, dur] of [['Regular Haircut', 300000, 30], ['Haircut + Beard', 450000, 45], ['Kids Haircut', 250000, 25], ['Full Grooming', 600000, 60]] as const) {
      await t.query('INSERT INTO services (barber_id, name, price_kobo, duration_min, active, created_at) VALUES ($1,$2,$3,$4,TRUE,$5)', [barberId, name, price, dur, now]);
    }
    for (const c of DEMO.customers) await t.query(ins, ['customer', c.name, c.email, c.phone, bcrypt.hashSync(c.password, rounds), now]);
    await t.query(`UPDATE barbers SET share_code=$1 WHERE id=$2`, [DEMO_SHARE_CODE, barberId]);
    // demo customers already have the demo shop in "My barbers" (real customers get a barber through the barber's private link)
    await t.query(`INSERT INTO customer_barbers (customer_id, barber_id, added, source, created_at) SELECT id, $1, TRUE, 'link', $2 FROM users WHERE role='customer'`, [barberId, now]);
    // demo accounts count as having accepted the current documents (otherwise every demo login would hit the re-accept prompt)
    await t.query(`INSERT INTO consent_log (user_id, document, version, accepted_at, source)
        SELECT u.id, d.doc, '1', $1, 'signup' FROM users u JOIN (VALUES ('terms','customer'),('privacy','customer'),('terms','barber'),('privacy','barber'),('barber_agreement','barber')) AS d(doc, r) ON d.r = u.role`, [now]);
    return { barberId };
  });
}
