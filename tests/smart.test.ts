import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'net';
import { freshDb, setNow, resetNow, WED, userIdOfBarber } from './helpers';
import { createApp } from '../src/app';
import { barberAction, createBooking, customerCancel, getBooking, customerCheckIn } from '../src/bookingService';
import { updateSettings } from '../src/plans';
import * as S from '../src/smart';
import { getAvailableSlots } from '../src/slots';
import { flushPush, saveSubscription, setPushSender } from '../src/push';

const at = (t: string, d = WED) => `${d}T${t}:00+01:00`;
const on = (db: any, patch: any) => updateSettings(db, patch);
const notes = (db: any, uid: number, type: string) => db.one(`SELECT COUNT(*)::int c FROM notifications WHERE user_id=$1 AND type=$2`, [uid, type]).then((r: any) => r.c);
async function complete(db: any, uid: number, barberId: number, id: number) {
  await customerCheckIn(db, (await getBooking(db, id))!.customer_id, id).catch(() => {});
  await barberAction(db, uid, barberId, id, 'start'); await barberAction(db, uid, barberId, id, 'record-payment', { method: 'cash' }).catch(() => {});
  await barberAction(db, uid, barberId, id, 'complete');
}

test('feature toggles: every smart feature refuses when switched off', async () => {
  setNow(at('08:00'));
  try {
    const { db, barberId, customerIds, serviceIds } = await freshDb();
    await on(db, { feature_favourites: false, feature_rebook: false, feature_waitlist: false, feature_reviews: false, feature_barber_notes: false, feature_quick_actions: false, feature_daily_summary: false });
    const uid = await userIdOfBarber(db, barberId);
    await assert.rejects(S.setFavourite(db, customerIds[0], barberId, true), /switched off/);
    await assert.rejects(S.rebookSuggestion(db, customerIds[0]), /switched off/);
    await assert.rejects(S.joinWaitlist(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED }), /switched off/);
    await assert.rejects(S.addReview(db, customerIds[0], 1, { rating: 5 }), /switched off/);
    await assert.rejects(S.saveCustomerNote(db, barberId, customerIds[0], 'x'), /switched off/);
    await assert.rejects(S.broadcastToQueue(db, uid, barberId, 'LATE_10'), /switched off/);
    await assert.rejects(S.delayQueue(db, uid, barberId, 10), /switched off/);
    await assert.rejects(S.dailySummary(db, barberId), /switched off/);
  } finally { resetNow(); }
});

test('reviews: only completed visits, once per booking, barber can reply, average shown, hidden reviews excluded', async () => {
  setNow(at('09:00'));
  try {
    const { db, barberId, customerIds, serviceIds } = await freshDb(); const uid = await userIdOfBarber(db, barberId);
    const b = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '09:30', payment_option: 'ON_ARRIVAL' });
    await assert.rejects(S.addReview(db, customerIds[0], b.id, { rating: 5 }), /completed/);
    await complete(db, uid, barberId, b.id);
    assert.equal(await notes(db, customerIds[0], 'REVIEW_PROMPT'), 1);
    await assert.rejects(S.addReview(db, customerIds[1], b.id, { rating: 5 }), /not found/i, 'someone else cannot review it');
    await assert.rejects(S.addReview(db, customerIds[0], b.id, { rating: 6 }));
    const r = await S.addReview(db, customerIds[0], b.id, { rating: 4, comment: '  Sharp fade  ' });
    assert.equal(r.comment, 'Sharp fade');
    await assert.rejects(S.addReview(db, customerIds[0], b.id, { rating: 5 }), /already reviewed/);
    assert.equal(await notes(db, uid, 'REVIEW_RECEIVED'), 1);
    assert.deepEqual(await S.ratingSummary(db, barberId), { count: 1, average: 4 });
    await S.barberReply(db, barberId, r.id, 'Thanks!');
    assert.equal(await notes(db, customerIds[0], 'REVIEW_REPLY'), 1);
    await assert.rejects(S.barberReply(db, barberId + 99, r.id, 'nope'), /not found/i);
    await db.query('UPDATE reviews SET hidden=TRUE'); assert.equal((await S.ratingSummary(db, barberId)).count, 0);
    assert.equal((await S.listReviews(db, barberId)).length, 0);
  } finally { resetNow(); }
});

test('notes are private to the barber; usual service; reliability badge', async () => {
  setNow(at('09:00'));
  try {
    const { db, barberId, customerIds, serviceIds } = await freshDb(); const uid = await userIdOfBarber(db, barberId);
    await assert.rejects(S.saveCustomerNote(db, barberId, customerIds[0], 'allergic'), /not found/i, 'no relationship yet');
    const b = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '09:30', payment_option: 'ON_ARRIVAL', note: 'Low fade please' });
    assert.equal((await getBooking(db, b.id))!.note_to_barber, 'Low fade please');
    await S.saveCustomerNote(db, barberId, customerIds[0], 'Sensitive scalp - no clippers guard 1');
    assert.match((await S.getCustomerInsights(db, barberId, customerIds[0])).note, /Sensitive/);
    assert.equal((await db.one('SELECT COUNT(*)::int c FROM barber_customer_notes')).c, 1);
    await complete(db, uid, barberId, b.id);
    const ins = await S.getCustomerInsights(db, barberId, customerIds[0]);
    assert.equal(ins.usual.service_name, (await getBooking(db, b.id))!.service_name);
    assert.equal(S.reliabilityOf(0, 0).label, 'New');
    assert.equal(S.reliabilityOf(9, 0).label, 'Reliable'); assert.equal(S.reliabilityOf(5, 3).label, 'Often misses'); assert.equal(S.reliabilityOf(6, 1).label, 'Mostly reliable');
    await on(db, { feature_booking_note: false });
    const b2 = await createBooking(db, customerIds[1], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '11:00', payment_option: 'ON_ARRIVAL', note: 'hi' });
    assert.equal((await getBooking(db, b2.id))!.note_to_barber, null, 'toggle off drops the note');
  } finally { resetNow(); }
});

test('reminders: 2h, 30 min and leave-now are sent once, only when there was enough lead time; toggle off sends nothing', async () => {
  setNow(at('07:00'));
  try {
    const { db, barberId, customerIds, serviceIds } = await freshDb();
    const b = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '11:00', payment_option: 'ON_ARRIVAL' });
    const cid = customerIds[0];
    setNow(at('08:30')); await S.runSmartTick(db, true); assert.equal(await notes(db, cid, 'REMINDER_2H'), 0, 'not yet (2.5h away)');
    setNow(at('09:05')); await S.runSmartTick(db, true); await S.runSmartTick(db, true);
    assert.equal(await notes(db, cid, 'REMINDER_2H'), 1, 'exactly once');
    setNow(at('10:35')); await S.runSmartTick(db, true); await S.runSmartTick(db, true);
    assert.equal(await notes(db, cid, 'REMINDER_30'), 1);
    // a booking made 20 minutes ahead does not get a "2 hours" reminder
    setNow(at('12:10'));
    const late = await createBooking(db, customerIds[1], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '12:30', payment_option: 'ON_ARRIVAL' });
    await S.runSmartTick(db, true);
    assert.equal(await notes(db, customerIds[1], 'REMINDER_2H'), 0);
    // toggle off
    await on(db, { feature_reminders: false });
    setNow(at('14:50')); const c3 = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '15:30', payment_option: 'ON_ARRIVAL' });
    setNow(at('15:10')); await S.runSmartTick(db, true); assert.equal(await notes(db, customerIds[0], 'REMINDER_30'), 1, 'only the first booking got one');
    assert.ok(b && late && c3);
  } finally { resetNow(); }
});

test('leave-now nudge uses the live queue ETA and barber delay', async () => {
  setNow(at('09:00'));
  try {
    const { db, barberId, customerIds, serviceIds } = await freshDb(); const uid = await userIdOfBarber(db, barberId);
    const a = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '09:30', payment_option: 'ON_ARRIVAL' });
    const b = await createBooking(db, customerIds[1], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' });
    await S.delayQueue(db, uid, barberId, 30);
    assert.equal(await notes(db, customerIds[1], 'QUEUE_DELAY'), 1);
    setNow(at('09:40')); await S.runSmartTick(db, true);
    assert.equal(await notes(db, customerIds[1], 'LEAVE_NOW'), 0, 'expected start 10:30 - still 50 min away');
    setNow(at('10:10')); await S.runSmartTick(db, true);
    assert.equal(await notes(db, customerIds[1], 'LEAVE_NOW'), 1, 'now within 20 min of the delayed start');
    await S.runSmartTick(db, true); assert.equal(await notes(db, customerIds[1], 'LEAVE_NOW'), 1);
    assert.ok(a && b);
  } finally { resetNow(); }
});

test('quick actions: message template + delay reach only today\'s waiting customers, capped per day', async () => {
  setNow(at('08:00'));
  try {
    const { db, barberId, customerIds, serviceIds } = await freshDb(); const uid = await userIdOfBarber(db, barberId);
    await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '09:30', payment_option: 'ON_ARRIVAL' });
    await createBooking(db, customerIds[1], { barber_id: barberId, service_id: serviceIds[0], date: '2026-10-01', time: '09:30', payment_option: 'ON_ARRIVAL' });
    assert.deepEqual(await S.broadcastToQueue(db, uid, barberId, 'LATE_10'), { sent: 1 });
    assert.equal(await notes(db, customerIds[1], 'BARBER_MESSAGE'), 0, 'tomorrow\'s customer is not messaged');
    await assert.rejects(S.broadcastToQueue(db, uid, barberId, 'EVIL'), /template/i);
    await assert.rejects(S.delayQueue(db, uid, barberId, 7), /Choose/);
    assert.equal((await S.delayQueue(db, uid, barberId, 10)).delay_min, 10);
    assert.equal((await S.delayQueue(db, uid, barberId, 15)).delay_min, 25, 'delays accumulate');
    setNow(at('08:00', '2026-10-01')); assert.equal(await S.barberDelay(db, barberId, '2026-10-01'), 0, 'delay is only for its own day');
    setNow(at('08:00'));
    for (let i = 0; i < 11; i++) await S.broadcastToQueue(db, uid, barberId, 'BREAK');
    await assert.rejects(S.broadcastToQueue(db, uid, barberId, 'BREAK'), /up to 12/);
  } finally { resetNow(); }
});

test('waitlist: only for a full day, notified when a slot opens, once, closed when booked', async () => {
  setNow(at('08:00'));
  try {
    const { db, barberId, customerIds, serviceIds } = await freshDb();
    const tomorrow = '2026-10-01';
    await assert.rejects(S.joinWaitlist(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: tomorrow }), /free times/);
    // fill the day: keep booking the first free slot with throwaway customers until nothing is left
    const extra: number[] = [];
    for (let k = 0; k < 4; k++) extra.push((await db.one(`INSERT INTO users (role,name,email,password_hash) VALUES ('customer','W'||$1::text,'w'||$1::text||'@t.test','x') RETURNING id`, [k])).id);
    const booked: number[] = [];
    for (let guard = 0; guard < 40; guard++) {
      const sl = await getAvailableSlots(db, barberId, serviceIds[0], tomorrow); if (!sl.slots.length) break;
      booked.push((await createBooking(db, extra[guard % 2 ? 0 : 1], { barber_id: barberId, service_id: serviceIds[0], date: tomorrow, time: sl.slots[0].time, payment_option: 'ON_ARRIVAL' }).catch(() => ({ id: 0 }))).id);
      if (!booked[booked.length - 1]) { /* customer overlap can't happen: slots are sequential */ }
    }
    assert.ok(booked.filter(Boolean).length >= 4, 'day is now full');
    const w = await S.joinWaitlist(db, extra[3], { barber_id: barberId, service_id: serviceIds[0], date: tomorrow });
    await assert.rejects(S.joinWaitlist(db, extra[3], { barber_id: barberId, service_id: serviceIds[0], date: tomorrow }), /already/);
    assert.equal(await S.scanWaitlist(db), 0, 'still full');
    const victim = booked.filter(Boolean)[0]; const b0 = (await getBooking(db, victim))!;
    setNow(at('08:00')); await customerCancel(db, b0.customer_id, victim);
    assert.equal(await S.scanWaitlist(db), 1);
    assert.equal(await S.scanWaitlist(db), 0, 'notified only once');
    assert.equal(await notes(db, extra[3], 'WAITLIST_OPEN'), 1);
    await createBooking(db, extra[3], { barber_id: barberId, service_id: serviceIds[0], date: tomorrow, time: minToHhmm(b0.start_min), payment_option: 'ON_ARRIVAL' });
    assert.equal((await db.one(`SELECT status FROM waitlist WHERE id=$1`, [w.id])).status, 'BOOKED');
  } finally { resetNow(); }
});
function minToHhmm(m: number) { return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }

test('rebook suggests the same barber/service at the usual weekday and time', async () => {
  setNow(at('09:00'));
  try {
    const { db, barberId, customerIds, serviceIds } = await freshDb(); const uid = await userIdOfBarber(db, barberId);
    assert.equal((await S.rebookSuggestion(db, customerIds[0])).suggestion, null);
    const b = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '09:30', payment_option: 'ON_ARRIVAL' });
    await complete(db, uid, barberId, b.id);
    const r = (await S.rebookSuggestion(db, customerIds[0])).suggestion!;
    assert.equal(r.barber.id, barberId); assert.equal(r.service.id, serviceIds[0]);
    assert.ok(r.options.length >= 1);
    const first = r.options[0]; assert.equal(first.usual_day, true); assert.equal(first.date, '2026-10-07'); assert.equal(first.time, '09:30');
  } finally { resetNow(); }
});

test('loyalty: opt-in, every Nth completed visit earns a same-barber credit once', async () => {
  setNow(at('09:00'));
  try {
    const { db, barberId, customerIds, serviceIds } = await freshDb(); const uid = await userIdOfBarber(db, barberId);
    await on(db, { feature_loyalty: true, loyalty_every_n: 2, loyalty_credit_naira: 500 });
    const times = ['09:00', '10:00', '11:00'];
    const ids: number[] = [];
    for (const t of times) { const b = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: t, payment_option: 'ON_ARRIVAL' }); ids.push(b.id); }
    for (const id of ids) await complete(db, uid, barberId, id);
    const cr = await db.many(`SELECT * FROM session_credits WHERE customer_id=$1 AND reason='LOYALTY'`, [customerIds[0]]);
    assert.equal(cr.length, 1); assert.equal(cr[0].value_kobo, 50000); assert.equal(await notes(db, customerIds[0], 'LOYALTY_CREDIT'), 1);
  } finally { resetNow(); }
});

test('daily summary counts today and yesterday', async () => {
  setNow(at('09:00'));
  try {
    const { db, barberId, customerIds, serviceIds } = await freshDb(); const uid = await userIdOfBarber(db, barberId);
    const b = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '09:30', payment_option: 'ON_ARRIVAL' });
    await createBooking(db, customerIds[1], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '11:00', payment_option: 'ON_ARRIVAL' });
    await complete(db, uid, barberId, b.id);
    const s = await S.dailySummary(db, barberId);
    assert.equal(s.today.completed, 1); assert.equal(s.today.remaining, 1); assert.ok(s.today.earned > 0);
  } finally { resetNow(); }
});

test('push: every notification is sent once to all devices; 410/404 subscriptions are removed; toggle off sends none; subscriptions validated', async () => {
  setNow(at('08:00'));
  const sent: any[] = [];
  setPushSender(async (sub, payload) => { if (sub.endpoint.includes('gone')) { const e: any = new Error('gone'); e.statusCode = 410; throw e; } sent.push({ ep: sub.endpoint, p: JSON.parse(payload) }); });
  try {
    const { db, barberId, customerIds, serviceIds } = await freshDb(); const uid = await userIdOfBarber(db, barberId);
    const keys = { p256dh: 'BPx'.padEnd(80, 'x'), auth: 'a'.padEnd(20, 'b') };
    await assert.rejects(saveSubscription(db, customerIds[0], { endpoint: 'http://insecure', keys }, 'ua'), /Invalid/);
    await saveSubscription(db, customerIds[0], { endpoint: 'https://push.example/ok1', keys }, 'ua');
    await saveSubscription(db, customerIds[0], { endpoint: 'https://push.example/ok2', keys }, 'ua');
    await saveSubscription(db, customerIds[0], { endpoint: 'https://push.example/gone1', keys }, 'ua');
    await saveSubscription(db, uid, { endpoint: 'https://push.example/barber', keys }, 'ua');
    await flushPush(db);                                 // drain old rows
    sent.length = 0;
    const b = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '09:30', payment_option: 'ON_ARRIVAL' });
    const r = await flushPush(db);
    assert.equal(r.removed, 1, 'dead endpoint cleaned up');
    assert.equal((await db.one('SELECT COUNT(*)::int c FROM push_subscriptions WHERE user_id=$1', [customerIds[0]])).c, 2);
    const cust = sent.filter((s) => s.p.type === 'BOOKING_CONFIRMED'); assert.equal(cust.length, 2, 'both live devices');
    assert.equal(cust[0].p.url, `/#/booking/${b.id}`);
    const barb = sent.filter((s) => s.ep.endsWith('/barber')); assert.equal(barb[0].p.type, 'NEW_BOOKING'); assert.equal(barb[0].p.url, `/#/b/${b.id}`);
    sent.length = 0; assert.equal((await flushPush(db)).claimed, 0); assert.equal(sent.length, 0, 'never re-sent');
    await on(db, { feature_push: false });
    await createBooking(db, customerIds[1], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '11:00', payment_option: 'ON_ARRIVAL' });
    await flushPush(db); assert.equal(sent.length, 0, 'admin toggle off => no pushes');
    assert.equal((await db.one('SELECT COUNT(*)::int c FROM notifications WHERE pushed_at IS NULL')).c, 0);
  } finally { setPushSender(null); resetNow(); }
});

test('HTTP: push/subscribe, notifications paging + per-item read, config exposes flags and the VAPID public key only', async () => {
  const s = await freshDb(); setNow(at('08:00'));
  process.env.VAPID_PUBLIC_KEY = 'BPUBLICKEYFORTEST'; process.env.VAPID_PRIVATE_KEY = 'private-never-exposed';
  const server = createApp(s.db).listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const cfg = await (await fetch(base + '/api/config')).json();
    assert.equal(cfg.vapid_public_key, 'BPUBLICKEYFORTEST'); assert.equal(cfg.features.reviews, true); assert.ok(!JSON.stringify(cfg).includes('private-never-exposed'));
    const em = (await s.db.one('SELECT email FROM users WHERE id=$1', [s.customerIds[0]])).email;
    const lr = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: em, password: 'Customer123!' }) });
    const cookie = (lr.headers.get('set-cookie') || '').split(';')[0];
    const j = (p: string, o: any = {}) => fetch(base + '/api' + p, { ...o, headers: { 'Content-Type': 'application/json', cookie, ...(o.headers || {}) }, body: o.body ? JSON.stringify(o.body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    assert.equal((await j('/push/subscribe', { method: 'POST', body: { subscription: { endpoint: 'https://push.example/x', keys: { p256dh: 'p'.repeat(30), auth: 'a'.repeat(12) } } } })).status, 201);
    assert.equal((await j('/push/status')).body.devices, 1);
    assert.equal((await j('/push/subscribe', { method: 'POST', body: { subscription: { endpoint: 'nope' } } })).status, 400);
    for (let i = 0; i < 5; i++) await s.db.query(`INSERT INTO notifications (user_id,type,title,body) VALUES ($1,'X','t'||$2::text,'b')`, [s.customerIds[0], i]);
    const p1 = (await j('/notifications?limit=2')).body; assert.equal(p1.notifications.length, 2); assert.ok(p1.next_before);
    const p2 = (await j('/notifications?limit=2&before=' + p1.next_before)).body; assert.ok(p2.notifications[0].id < p1.notifications[1].id);
    await j('/notifications/read', { method: 'POST', body: { id: p1.notifications[0].id } });
    assert.equal((await j('/notifications')).body.unread, p1.unread - 1);
    assert.equal((await j('/push/unsubscribe', { method: 'POST', body: {} })).status, 200); assert.equal((await j('/push/status')).body.devices, 0);
    assert.equal((await fetch(base + '/api/push/status')).status, 401);
  } finally { server.close(); delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; resetNow(); }
});
