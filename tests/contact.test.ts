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
