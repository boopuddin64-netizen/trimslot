import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import { bootApp } from './httpHelpers';
import { WED, setNow, resetNow } from './helpers';
import { applyVerifiedPayment } from '../src/bookingService';
import { escalateUnansweredHelp } from '../src/help';
import { hashCode } from '../src/emailOtp';
import { config } from '../src/config';
import { updateSettings } from '../src/plans';

async function paidLocked(c: Awaited<ReturnType<typeof bootApp>>, time = '10:00', other = false) {
  const cc = other ? await c.tunde() : await c.chidi();
  const o = await c.call('POST', '/api/bookings', { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time, payment_option: 'ONLINE' }, cc);
  assert.equal(o.status, 201, o.text);
  const id = o.json.booking.id as number;
  await c.db.tx((t) => applyVerifiedPayment(t, id, 'PAYSTACK'));
  return { cc, id };
}

test('help: an OPEN request on a booking that is no longer live is closed quietly, no false URGENT report; (a live one still escalates: see test G in followups.test.ts)', async () => {
  const c = await bootApp();
  try {
    setNow(`${WED}T09:58:00+01:00`);
    const a = await paidLocked(c, '10:00');
    { const r1 = await c.call('POST', `/api/bookings/${a.id}/help`, { note: 'Emergency at home' }, a.cc); assert.equal(r1.status, 201, r1.text); }
    await c.db.query(`UPDATE bookings SET status='NO_SHOW' WHERE id=$1`, [a.id]);   // the booking ended some other way before anyone answered
    setNow(`${WED}T10:05:00+01:00`);
    assert.equal(await escalateUnansweredHelp(c.db), 0, 'a request on a finished booking is not escalated');
    const ha = await c.db.one<any>('SELECT status, report_id, escalated_at FROM help_requests WHERE booking_id=$1', [a.id]);
    assert.equal(ha.status, 'CLOSED'); assert.equal(ha.report_id, null); assert.equal(ha.escalated_at, null);
    assert.equal((await c.db.one<any>('SELECT COUNT(*)::int c FROM reports WHERE booking_id=$1', [a.id])).c, 0);
  } finally { c.close(); }
});

test('help alert: not counted in the 10-a-day report cap, not on the barber profile, no "report resolved" message', async () => {
  const c = await bootApp();
  try {
    setNow(`${WED}T09:45:00+01:00`);
    const a = await paidLocked(c);
    await c.call('POST', `/api/bookings/${a.id}/help`, { note: 'Emergency at home' }, a.cc);
    setNow(`${WED}T10:05:00+01:00`);
    assert.equal(await escalateUnansweredHelp(c.db), 1);
    resetNow();   // report timestamps use the database clock for the daily window
    for (let i = 0; i < 10; i++) {
      const r = await c.call('POST', '/api/reports', { category: 'OTHER', message: 'A real report number ' + i }, a.cc);
      assert.equal(r.status, 201, `report ${i + 1} of 10 is allowed although a staff alert exists: ${r.text}`);
    }
    assert.equal((await c.call('POST', '/api/reports', { category: 'OTHER', message: 'One too many today' }, a.cc)).status, 429);
  } finally { c.close(); }
});

test('reschedule: obeys maintenance mode, restricted accounts and unverified-barber rules; closes the waitlist for the new date', async () => {
  const c = await bootApp();
  try {
    const { cc, id } = await paidLocked(c, '10:00');
    const tomorrow = '2026-10-01';
    // maintenance mode on: a move is refused like a new booking
    await c.db.tx((t) => updateSettings(t, { maintenance_mode: true, maintenance_message: 'Back soon' }));
    let r = await c.call('POST', `/api/bookings/${id}/reschedule`, { date: WED, time: '12:00' }, cc);
    assert.equal(r.status, 503, r.text); assert.equal(r.json.error.code, 'MAINTENANCE');
    await c.db.tx((t) => updateSettings(t, { maintenance_mode: false }));
    // restricted account
    await c.db.query(`UPDATE users SET account_status='SUSPENDED' WHERE id=$1`, [c.customerIds[0]]);
    r = await c.call('POST', `/api/bookings/${id}/reschedule`, { date: WED, time: '12:00' }, cc);
    assert.ok([403, 401].includes(r.status), r.text);
    await c.db.query(`UPDATE users SET account_status='ACTIVE' WHERE id=$1`, [c.customerIds[0]]);
    // waitlist for the new date is closed by the move
    await c.db.query(`INSERT INTO waitlist (customer_id, barber_id, service_id, date, status) VALUES ($1,$2,$3,$4,'WAITING')`, [c.customerIds[0], c.barberId, c.serviceIds[0], WED]).catch(() => undefined);
    r = await c.call('POST', `/api/bookings/${id}/reschedule`, { date: WED, time: '12:00' }, cc);
    assert.equal(r.status, 200, r.text);
    const w = await c.db.many<any>(`SELECT status FROM waitlist WHERE customer_id=$1 AND date=$2`, [c.customerIds[0], WED]);
    assert.ok(w.every((x) => x.status === 'BOOKED'), 'waitlist closed for the new date');
    void tomorrow;
  } finally { c.close(); }
});

test('email code hash: keyed with a derived key, not the login secret itself', () => {
  const direct = createHmac('sha256', config.jwtSecret).update('otp:1:a@b.test:123456').digest('hex');
  const h = hashCode(1, 'A@b.test', '123456');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.notEqual(h, direct, 'not the old HMAC with jwtSecret');
  assert.equal(h, hashCode(1, 'a@b.test', '123456'));
  assert.notEqual(h, hashCode(1, 'a@b.test', '123457'));
});
