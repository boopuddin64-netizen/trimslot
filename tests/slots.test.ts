import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { generateSlots, getAvailableSlots } from '../src/slots';
import { createBooking } from '../src/bookingService';

test.beforeEach(() => setNow('2026-09-29T08:00:00+01:00'));
test.afterEach(() => resetNow());

const sched = { is_working: true, start_min: 540, end_min: 1080, break_start_min: 780, break_end_min: 840 };
const mk = (db: any, cid: number, barber_id: number, service_id: number, date: string, time: string, payment_option: any = 'ON_ARRIVAL') =>
  createBooking(db, cid, { barber_id, service_id, date, time, payment_option });

test('generateSlots respects hours, duration and break', () => {
  const s = generateSlots({ schedule: sched, isDayOff: false, durationMin: 60, busy: [] });
  const starts = s.map((x) => x.start);
  assert.equal(starts[0], 540);
  assert.ok(!starts.includes(750));                   // 12:30-13:30 would hit the break
  assert.ok(!starts.includes(780));
  assert.ok(starts.includes(720));                    // 12:00-13:00 ends exactly at break start -> ok
  assert.ok(starts.includes(840));
  assert.equal(starts[starts.length - 1], 1020);
  assert.ok(!starts.includes(1035));
});

test('generateSlots removes overlaps with existing bookings and day off / closed days', () => {
  const s = generateSlots({ schedule: sched, isDayOff: false, durationMin: 30, busy: [{ start: 600, end: 645 }] });
  const starts = s.map((x) => x.start);
  assert.ok(starts.includes(570));
  assert.ok(!starts.includes(585));
  assert.ok(!starts.includes(630));
  assert.ok(starts.includes(645));
  assert.equal(generateSlots({ schedule: sched, isDayOff: true, durationMin: 30, busy: [] }).length, 0);
  assert.equal(generateSlots({ schedule: { ...sched, is_working: false }, isDayOff: false, durationMin: 30, busy: [] }).length, 0);
});

test('slots for today drop times already passed', () => {
  const s = generateSlots({ schedule: sched, isDayOff: false, durationMin: 30, busy: [], nowMin: 610 });
  assert.equal(s[0].start, 615);
});

test('Sunday is closed for the seeded barber; Wednesday has slots', async () => {
  const { db, barberId, serviceIds } = await freshDb();
  const sun = await getAvailableSlots(db, barberId, serviceIds[0], '2026-10-04');
  assert.equal(sun.slots.length, 0);
  assert.match(sun.closed_reason!, /does not work/);
  assert.ok((await getAvailableSlots(db, barberId, serviceIds[0], WED)).slots.length > 10);
});

test('booking removes the slot and overlapping bookings are rejected (no double booking)', async () => {
  const { db, barberId, customerIds, serviceIds } = await freshDb();
  const b1 = await mk(db, customerIds[0], barberId, serviceIds[1], WED, '10:00'); // 45 min
  assert.equal(b1.status, 'CONFIRMED');
  assert.equal(b1.payment_status, 'PAYMENT_DUE');
  const times = (await getAvailableSlots(db, barberId, serviceIds[0], WED)).slots.map((s) => s.time);
  assert.ok(!times.includes('10:00') && !times.includes('10:15') && !times.includes('10:30'));
  assert.ok(times.includes('09:30') && times.includes('10:45'));
  for (const t of ['10:00', '10:15', '10:30', '09:45']) {
    await assert.rejects(mk(db, customerIds[1], barberId, serviceIds[0], WED, t), /no longer available/);
  }
  assert.equal((await mk(db, customerIds[1], barberId, serviceIds[0], WED, '10:45')).start_min, 645);
});

test('Lagos time derivation: date/start_min/end_min are generated from the timestamptz instant', async () => {
  const { db, barberId, customerIds, serviceIds } = await freshDb();
  const b = await mk(db, customerIds[0], barberId, serviceIds[1], WED, '09:30');
  assert.equal(b.scheduled_at, '2026-09-30T08:30:00.000Z');     // 09:30 Lagos == 08:30Z
  assert.equal(b.ends_at, '2026-09-30T09:15:00.000Z');
  assert.equal(b.date, '2026-09-30');
  assert.equal(b.start_min, 570);
  assert.equal(b.end_min, 615);
});

test('DB constraints alone block same-start AND overlapping inserts even if the app checks were bypassed', async () => {
  const { db, barberId, customerIds, serviceIds } = await freshDb();
  await mk(db, customerIds[0], barberId, serviceIds[0], WED, '11:00');   // 11:00-11:30 Lagos
  const raw = (start: string, end: string) => db.query(`INSERT INTO bookings (customer_id, barber_id, service_id, scheduled_at, ends_at, service_name, price_kobo, duration_min, status, payment_option, payment_status)
    VALUES ($1,$2,$3,$4,$5,'x',1,30,'CONFIRMED','ON_ARRIVAL','PAYMENT_DUE')`, [customerIds[1], barberId, serviceIds[0], start, end]);
  await assert.rejects(raw('2026-09-30T10:00:00Z', '2026-09-30T10:30:00Z'), (e: any) => e.code === '23505');  // uq_bookings_active_slot
  const ext = await db.maybeOne(`SELECT 1 FROM pg_constraint WHERE conname='bookings_no_overlap'`);
  assert.ok(ext, 'btree_gist exclusion constraint should exist on a stock Postgres');
  await assert.rejects(raw('2026-09-30T10:15:00Z', '2026-09-30T10:45:00Z'), (e: any) => e.code === '23P01');  // overlap, different start
  await raw('2026-09-30T10:30:00Z', '2026-09-30T11:00:00Z');                                                    // touching (back-to-back) is fine
});

test('price is snapshotted; client cannot set price', async () => {
  const { db, barberId, customerIds, serviceIds } = await freshDb();
  const b = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '09:00', payment_option: 'ON_ARRIVAL', price_kobo: 1 } as any);
  assert.equal(b.price_kobo, 300000);
  await db.query('UPDATE services SET price_kobo=999900, name=$1 WHERE id=$2', ['Renamed', serviceIds[0]]);
  const again = await db.one('SELECT price_kobo, service_name FROM bookings WHERE id=$1', [b.id]);
  assert.equal(again.price_kobo, 300000);
  assert.equal(again.service_name, 'Regular Haircut');
});

test('cannot book in the past, outside hours, in break, on a day off, or with an unverified barber', async () => {
  const { db, barberId, customerIds, serviceIds } = await freshDb();
  const t = (date: string, time: string) => mk(db, customerIds[0], barberId, serviceIds[0], date, time);
  await assert.rejects(t('2026-09-28', '10:00'), /past/);
  await assert.rejects(t(WED, '08:00'), /no longer available/);
  await assert.rejects(t(WED, '13:00'), /no longer available/);
  await assert.rejects(t(WED, '17:45'), /no longer available/);
  await db.query('INSERT INTO days_off (barber_id, date, reason) VALUES ($1,$2,$3)', [barberId, WED, 'Wedding']);
  await assert.rejects(t(WED, '10:00'), /no longer available/);
  await db.query('UPDATE barbers SET verified=FALSE WHERE id=$1', [barberId]);
  await assert.rejects(t('2026-10-01', '10:00'), /not found/i);
});

test('an unpaid pay-now attempt holds NOTHING; a complete (pay-on-arrival) booking blocks the slot until it is cancelled', async () => {
  const { db, barberId, customerIds, serviceIds } = await freshDb();
  const b = await mk(db, customerIds[0], barberId, serviceIds[0], WED, '10:00', 'ONLINE');
  assert.equal(b.status, 'PENDING_PAYMENT');
  assert.equal(b.payment_status, 'PENDING');
  assert.ok((await getAvailableSlots(db, barberId, serviceIds[0], WED)).slots.some((s) => s.time === '10:00'), 'unpaid attempt does not block');
  const c = await mk(db, customerIds[1], barberId, serviceIds[0], WED, '10:00');   // a complete booking takes the very same slot
  assert.equal(c.status, 'CONFIRMED');
  assert.ok(!(await getAvailableSlots(db, barberId, serviceIds[0], WED)).slots.some((s) => s.time === '10:00'), 'complete booking blocks the time for everyone');
  await assert.rejects(mk(db, customerIds[0], barberId, serviceIds[1], WED, '10:00'), (e: any) => e.code === 'SLOT_UNAVAILABLE');
  assert.equal((await db.one('SELECT status FROM bookings WHERE id=$1', [b.id])).status, 'PENDING_PAYMENT'); // the attempt is untouched
});
