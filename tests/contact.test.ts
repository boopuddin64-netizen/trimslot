import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from './httpHelpers';
import { WED } from './helpers';
import { applyVerifiedPayment } from '../src/bookingService';
import { phoneLinks } from '../src/helpers';

test('phoneLinks: Nigerian local numbers become +234 links, junk gives null', () => {
  assert.deepEqual(phoneLinks('0803 123 4567'), { tel: 'tel:+2348031234567', whatsapp: 'https://wa.me/2348031234567' });
  assert.equal(phoneLinks('+2348031234567')!.whatsapp, 'https://wa.me/2348031234567');
  assert.equal(phoneLinks('+44 20 7946 0958')!.whatsapp, 'https://wa.me/442079460958');
  assert.equal(phoneLinks('abc'), null);
  assert.equal(phoneLinks(null), null);
});

test('contact barber: phone is shown to the customer only when paid and CONFIRMED/ARRIVED; barber gets the customer links', async () => {
  const c = await bootApp();
  try {
    const cc = await c.chidi(), mk = await c.mike();
    const book = (time: string, payment_option: string) => c.call('POST', '/api/bookings', { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time, payment_option }, cc);
    // Pay on arrival: payment not confirmed -> no barber phone
    const a = await book('10:00', 'ON_ARRIVAL');
    assert.equal(a.status, 201, a.text);
    assert.equal(a.json.booking.barber_contact, undefined);
    assert.ok(!a.text.includes('8031234567'), 'barber number must not leak');
    // Pay now: unpaid hold -> none; after payment -> present
    const o = await book('11:00', 'ONLINE');
    assert.equal(o.status, 201, o.text);
    assert.equal(o.json.booking.barber_contact, undefined);
    await c.db.tx((t) => applyVerifiedPayment(t, o.json.booking.id, 'PAYSTACK'));
    const paid = await c.call('GET', `/api/bookings/${o.json.booking.id}`, undefined, cc);
    assert.equal(paid.json.booking.status, 'CONFIRMED');
    assert.equal(paid.json.booking.barber_contact.tel_url, 'tel:+2348031234567');
    assert.equal(paid.json.booking.barber_contact.whatsapp_url, 'https://wa.me/2348031234567');
    // other states: arrived keeps it, cancelled/completed removes it
    await c.db.query(`UPDATE bookings SET status='COMPLETED' WHERE id=$1`, [o.json.booking.id]);
    const done = await c.call('GET', `/api/bookings/${o.json.booking.id}`, undefined, cc);
    assert.equal(done.json.booking.barber_contact, undefined);
    // never in the barber page for customers
    const prof = await c.call('GET', `/api/barbers/${c.barberId}`, undefined, cc);
    assert.ok(!prof.text.includes('8031234567'), 'directory/profile must not show the barber phone');
    // barber side: customer links
    const bb = await c.call('GET', `/api/barber/bookings/${a.json.booking.id}`, undefined, mk);
    assert.equal(bb.json.booking.customer.tel_url, 'tel:+2348055550001');
    assert.equal(bb.json.booking.customer.whatsapp_url, 'https://wa.me/2348055550001');
  } finally { c.close(); }
});

test('CANCEL_LOCKED text matches real behaviour: credit only on a no-show, barber decides, no invented promises', async () => {
  const c = await bootApp();
  try {
    const cc = await c.chidi();
    const b = await c.call('POST', '/api/bookings', { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' }, cc);
    const { setNow } = await import('./helpers'); setNow(`${WED}T09:45:00+01:00`);
    const r = await c.call('POST', `/api/bookings/${b.json.booking.id}/cancel`, {}, cc);
    assert.equal(r.status, 403); assert.equal(r.json.error.code, 'CANCEL_LOCKED');
    assert.match(r.json.error.message, /marks a no-show/i);
    assert.match(r.json.error.message, /Your barber decides/);
    assert.doesNotMatch(r.json.error.message, /If you miss it, you get/i);
  } finally { c.close(); }
});

/* ---------- Emergency, please help ---------- */
import { setNow } from './helpers';
import { setPushSender } from '../src/push';
import { flushPush } from '../src/push';
import { escalateUnansweredHelp } from '../src/help';
import { HELP_ESCALATE_MIN } from '../src/config';

async function lockedPaid(c: Awaited<ReturnType<typeof bootApp>>, time = '10:00') {
  const cc = await c.chidi();
  const o = await c.call('POST', '/api/bookings', { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time, payment_option: 'ONLINE' }, cc);
  assert.equal(o.status, 201, o.text);
  await c.db.tx((t) => applyVerifiedPayment(t, o.json.booking.id, 'PAYSTACK'));
  return { cc, id: o.json.booking.id as number };
}

test('help: only on a locked, paid, upcoming booking; one open request per booking; barber gets an urgent in-app + push notification', async () => {
  const c = await bootApp();
  const pushes: any[] = []; setPushSender(async (_s, payload) => { pushes.push(JSON.parse(payload)); });
  try {
    const { cc, id } = await lockedPaid(c);
    const { saveSubscription } = await import('../src/push'); const { userIdOfBarber } = await import('./helpers');
    await saveSubscription(c.db, await userIdOfBarber(c.db, c.barberId), { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } }, 'test');
    // not locked yet (08:00, visit 10:00): cancelling is still possible
    let r = await c.call('POST', `/api/bookings/${id}/help`, { note: 'Stuck in traffic' }, cc);
    assert.equal(r.status, 409); assert.equal(r.json.error.code, 'HELP_NOT_NEEDED');
    setNow(`${WED}T09:45:00+01:00`);
    const view = await c.call('GET', `/api/bookings/${id}`, undefined, cc);
    assert.equal(view.json.booking.can_ask_help, true);
    r = await c.call('POST', `/api/bookings/${id}/help`, { note: '   ' }, cc); assert.equal(r.status, 400);
    r = await c.call('POST', `/api/bookings/${id}/help`, { note: 'x'.repeat(201) }, cc); assert.equal(r.status, 400);
    r = await c.call('POST', `/api/bookings/${id}/help`, { note: 'My child is sick, I may be late' }, cc);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.booking.help.status, 'OPEN'); assert.equal(r.json.booking.can_ask_help, false);
    // second one on the same booking is refused
    r = await c.call('POST', `/api/bookings/${id}/help`, { note: 'Again please' }, cc);
    assert.equal(r.status, 409); assert.equal(r.json.error.code, 'HELP_ALREADY_OPEN');
    // someone else cannot ask on it
    assert.equal((await c.call('POST', `/api/bookings/${id}/help`, { note: 'Not mine' }, await c.tunde())).status, 404);
    // barber: high-priority in-app notification + push, and the open request on the booking
    const n = await c.db.one(`SELECT * FROM notifications WHERE type='HELP_REQUEST'`);
    assert.match(n.body, /My child is sick/);
    await flushPush(c.db);
    assert.ok((await c.db.one(`SELECT pushed_at FROM notifications WHERE id=$1`, [n.id])).pushed_at);
    const p = pushes.find((x) => x.type === 'HELP_REQUEST');
    assert.ok(p, 'barber got a push'); assert.equal(p.url, `/#/b/${id}`); assert.match(p.body, /My child is sick/);
    const mk = await c.mike();
    const bb = await c.call('GET', `/api/barber/bookings/${id}`, undefined, mk);
    assert.equal(bb.json.booking.help.note, 'My child is sick, I may be late');
    assert.ok(bb.json.booking.customer.tel_url);
    // pay-on-arrival (not paid) booking cannot use it
    setNow(`${WED}T08:00:00+01:00`);
    const oa = await c.call('POST', '/api/bookings', { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time: '12:00', payment_option: 'ON_ARRIVAL' }, cc);
    setNow(`${WED}T11:45:00+01:00`);
    r = await c.call('POST', `/api/bookings/${oa.json.booking.id}/help`, { note: 'Please help' }, cc);
    assert.equal(r.status, 409); assert.equal(r.json.error.code, 'HELP_NOT_AVAILABLE');
  } finally { setPushSender(null); c.close(); }
});

test('help: barber answers with the existing actions (Wait = come later, Not served = release); customer sees the status', async () => {
  const c = await bootApp();
  try {
    const mk = await c.mike();
    const a = await lockedPaid(c, '10:00');
    setNow(`${WED}T09:45:00+01:00`);
    await c.call('POST', `/api/bookings/${a.id}/help`, { note: 'Running late' }, a.cc);
    let r = await c.call('POST', `/api/barber/bookings/${a.id}/wait`, {}, mk);
    assert.equal(r.status, 200, r.text); assert.equal(r.json.booking.help, null);
    let v = await c.call('GET', `/api/bookings/${a.id}`, undefined, a.cc);
    assert.equal(v.json.booking.help.status, 'COME_LATER');
    assert.ok(await c.db.maybeOne(`SELECT 1 FROM notifications WHERE type='HELP_ANSWERED' AND user_id=$1`, [v.json.booking.customer_id]));
    // after an answer the customer may ask again (a new, separate request)
    assert.equal(v.json.booking.can_ask_help, true);
    await c.call('POST', `/api/bookings/${a.id}/help`, { note: 'Cannot come at all' }, a.cc);
    r = await c.call('POST', `/api/barber/bookings/${a.id}/not-served`, {}, mk);
    assert.equal(r.status, 200, r.text);
    v = await c.call('GET', `/api/bookings/${a.id}`, undefined, a.cc);
    assert.equal(v.json.booking.help.status, 'RELEASED'); assert.equal(v.json.booking.status, 'NOT_SERVED');
    assert.equal(v.json.booking.payment_status, 'REFUND_PENDING');
  } finally { c.close(); }
});

test('help: unanswered after HELP_ESCALATE_MIN is flagged to staff once (report + admin alert) and the customer sees it', async () => {
  const c = await bootApp();
  try {
    assert.equal(HELP_ESCALATE_MIN, 15);
    const a = await lockedPaid(c, '10:00');
    setNow(`${WED}T09:45:00+01:00`);
    await c.call('POST', `/api/bookings/${a.id}/help`, { note: 'Emergency at home' }, a.cc);
    setNow(`${WED}T09:59:00+01:00`);          // 14 min: too early
    assert.equal(await escalateUnansweredHelp(c.db), 0);
    assert.equal((await c.call('GET', `/api/bookings/${a.id}`, undefined, a.cc)).json.booking.help.escalated, false);
    setNow(`${WED}T10:01:00+01:00`);          // 16 min
    assert.equal((await c.call('GET', `/api/bookings/${a.id}`, undefined, a.cc)).json.booking.help.escalated, true, 'customer status is right even before the sweeper runs');
    assert.equal(await escalateUnansweredHelp(c.db), 1);
    assert.equal(await escalateUnansweredHelp(c.db), 0, 'only once');
    const rep = await c.db.one(`SELECT * FROM reports WHERE booking_id=$1`, [a.id]);
    assert.match(rep.message, /nobody answered in 15 minutes/); assert.equal(rep.status, 'OPEN');
    assert.equal((await c.db.one(`SELECT COUNT(*)::int c FROM admin_notifications WHERE event='HELP_UNANSWERED'`)).c, 1);
    assert.ok(await c.db.maybeOne(`SELECT 1 FROM notifications WHERE type='HELP_ESCALATED'`));
    // a barber answer after escalation still works and closes the request
    const r = await c.call('POST', `/api/barber/bookings/${a.id}/wait`, {}, await c.mike());
    assert.equal(r.status, 200, r.text);
    // the public settings never mention it
    const ps = await c.call('GET', '/api/public-settings');
    assert.doesNotMatch(ps.text, /escalat|help/i);
  } finally { c.close(); }
});
