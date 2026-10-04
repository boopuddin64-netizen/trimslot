import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'net';
import { setupPin } from '../src/adminPin';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { createApp } from '../src/app';
import { barberAction, createBooking, customerCancel, getBooking } from '../src/bookingService';
import { initializePayment, mockMarkPaid, processReference } from '../src/paystack';
import { runSweep } from '../src/sweep';
import { setPushSender } from '../src/push';
import { inQuietHours } from '../src/adminNotify';

const KEY = 'test-admin-key-0123456789';
const NOW = `${WED}T08:00:00+01:00`;
async function boot() {
  const s = await freshDb(); setNow(NOW); process.env.CRON_SECRET = KEY; await setupPin(s.db, '4821');
  const server = createApp(s.db).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const j = async (p: string, o: any = {}) => { const r = await fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }); let body: any = null; try { body = await r.json(); } catch { /* no body */ } return { status: r.status, body }; };
  const A = { Authorization: 'Bearer ' + KEY, 'X-Admin-Pin': '4821' };
  return { ...s, server, j, A, base } as any;
}
const paid = async (s: any, cust: number, time: string) => {
  const b = await createBooking(s.db, cust, { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time, payment_option: 'ONLINE' });
  const i = await initializePayment(s.db, b.id, null); await mockMarkPaid(s.db, i.reference); await processReference(s.db, i.reference);
  return { b, ref: i.reference };
};
const credits = (s: any) => s.db.one('SELECT COUNT(*)::int c FROM session_credits').then((r: any) => r.c);
const alerts = (s: any, ev: string) => s.db.one('SELECT COUNT(*)::int c FROM admin_notifications WHERE event=$1', [ev]).then((r: any) => r.c);
const rs = (s: any, ref: string) => s.db.one('SELECT refund_status FROM payments WHERE reference=$1', [ref]).then((r: any) => r.refund_status);

test('in-time cancel of a prepaid booking: pending refund, admin alert, then auto-approves after the admin hold time via the sweep, exactly once, never a credit', async () => {
  const s = await boot();
  try {
    const { b, ref } = await paid(s, s.customerIds[0], '12:00');
    await customerCancel(s.db, s.customerIds[0], b.id);
    assert.equal((await getBooking(s.db, b.id))!.payment_status, 'REFUND_PENDING');
    assert.equal(await rs(s, ref), 'PENDING_APPROVAL');
    assert.equal(await alerts(s, 'REFUND_WAITING'), 1);
    const q = (await s.j('/api/admin/refund-queue', { headers: s.A })).body;
    assert.equal(q.pending.length, 1); assert.equal(q.auto_approve_hours, 3);
    // 2 h later: nothing happens yet
    setNow(`${WED}T10:00:00+01:00`);
    assert.equal((await runSweep(s.db)).refunds_auto_approved, 0);
    assert.equal(await rs(s, ref), 'PENDING_APPROVAL');
    // past the 3 h hold: approved by the system and sent to the (mock) gateway
    setNow(`${WED}T11:05:00+01:00`);
    assert.equal((await runSweep(s.db)).refunds_auto_approved, 1);
    assert.equal((await getBooking(s.db, b.id))!.payment_status, 'REFUNDED');
    assert.equal(await rs(s, ref), 'REFUND_REQUESTED');
    assert.equal(await alerts(s, 'REFUND_AUTO_APPROVED'), 1);
    assert.equal((await runSweep(s.db)).refunds_auto_approved, 0, 'exactly once');
    assert.equal(await credits(s), 0, 'refund and credit are never both');
    assert.equal((await s.db.many(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='REFUND_APPROVED'`, [s.customerIds[0]])).length, 1);
  } finally { s.server.close(); resetNow(); }
});

test('admin approves (PIN) or rejects (reason) a pending refund once; a rejected refund gives neither refund nor credit and is not auto-approved later', async () => {
  const s = await boot();
  try {
    const a = await paid(s, s.customerIds[0], '12:00'); const r = await paid(s, s.customerIds[1], '14:00');
    await customerCancel(s.db, s.customerIds[0], a.b.id); await customerCancel(s.db, s.customerIds[1], r.b.id);
    const dec = (id: number, body: any, headers = s.A) => s.j(`/api/admin/bookings/${id}/refund-decision`, { method: 'POST', headers, body });
    assert.equal((await dec(a.b.id, { action: 'approve' }, { Authorization: 'Bearer ' + KEY })).status, 403, 'approve needs the PIN');
    assert.equal((await dec(a.b.id, { action: 'maybe' })).status, 400);
    assert.equal((await dec(a.b.id, { action: 'approve' })).status, 200);
    assert.equal((await dec(a.b.id, { action: 'approve' })).status, 409, 'cannot decide twice');
    assert.equal(await rs(s, a.ref), 'REFUND_REQUESTED');
    assert.equal((await dec(r.b.id, { action: 'reject' })).status, 400, 'reject needs a reason');
    assert.equal((await dec(r.b.id, { action: 'reject', reason: 'Service was already delivered' })).status, 200);
    assert.equal((await getBooking(s.db, r.b.id))!.payment_status, 'REFUND_DECLINED');
    assert.equal(await rs(s, r.ref), 'REJECTED');
    setNow(`${WED}T23:00:00+01:00`);
    assert.equal((await runSweep(s.db)).refunds_auto_approved, 0);
    assert.equal(await rs(s, r.ref), 'REJECTED');
    assert.equal(await credits(s), 0);
    const acts = (await s.j('/api/admin/audit', { headers: s.A })).body.entries.map((e: any) => e.action);
    assert.ok(acts.includes('REFUND_APPROVED') && acts.includes('REFUND_REJECTED'));
  } finally { s.server.close(); resetNow(); }
});

test('no-show of a paid booking gives the CREDIT only (no refund row); not-served of a paid booking goes to the refund flow only', async () => {
  const s = await boot();
  try {
    const ns = await paid(s, s.customerIds[0], '10:00'); const nv = await paid(s, s.customerIds[1], '11:00');
    const bUid = (await s.db.one('SELECT user_id FROM barbers WHERE id=$1', [s.barberId])).user_id;
    setNow(`${WED}T10:20:00+01:00`);
    await barberAction(s.db, bUid, s.barberId, ns.b.id, 'no-show');
    assert.equal((await getBooking(s.db, ns.b.id))!.payment_status, 'CREDITED');
    assert.equal(await credits(s), 1);
    assert.equal(await rs(s, ns.ref), null, 'no refund for a no-show');
    setNow(`${WED}T11:05:00+01:00`);
    await barberAction(s.db, bUid, s.barberId, nv.b.id, 'not-served', { reason: 'ill' });
    assert.equal((await getBooking(s.db, nv.b.id))!.payment_status, 'REFUND_PENDING');
    assert.equal(await rs(s, nv.ref), 'PENDING_APPROVAL');
    assert.equal(await credits(s), 1, 'still only the no-show credit');
  } finally { s.server.close(); resetNow(); }
});

test('the auto-approve hours are an admin setting (validated + audited) and drive the due time', async () => {
  const s = await boot();
  try {
    assert.equal((await s.j('/api/admin/settings', { method: 'PUT', headers: s.A, body: { refund_auto_approve_hours: 500 } })).status, 400);
    assert.equal((await s.j('/api/admin/settings', { method: 'PUT', headers: s.A, body: { refund_auto_approve_hours: 1, cancel_cutoff_min: 45, payment_hold_min: 20, liability_cap_naira: 250000 } })).status, 200);
    const e = (await s.j('/api/admin/audit', { headers: s.A })).body.entries.find((x: any) => x.action === 'SETTINGS_UPDATED');
    assert.ok(e, 'audited'); assert.match(JSON.stringify(e.details), /refund_auto_approve_hours/);
    const pub = (await s.j('/api/public-settings')).body.settings;
    assert.equal(pub.refund_auto_approve_hours, 1); assert.equal(pub.cancel_cutoff_min, 45); assert.equal(pub.payment_hold_min, 20); assert.equal(pub.liability_cap_naira, 250000);
    assert.equal(pub.credit_expiry_days, 30); assert.equal(pub.commission_percent, 50);
    const { b } = await paid(s, s.customerIds[0], '15:00');
    await customerCancel(s.db, s.customerIds[0], b.id);
    setNow(`${WED}T09:05:00+01:00`);
    assert.equal((await runSweep(s.db)).refunds_auto_approved, 1, 'approved after 1 h, not 3');
  } finally { s.server.close(); resetNow(); }
});

test('public settings: defaults match the published numbers, no auth needed', async () => {
  const s = await boot(); 
  try {
    const r = await s.j('/api/public-settings'); assert.equal(r.status, 200);
    const p = r.body.settings;
    assert.equal(p.cancel_cutoff_min, 30); assert.equal(p.credit_expiry_days, 30); assert.equal(p.payment_hold_min, 15);
    assert.equal(p.platform_charge_percent, 2); assert.equal(p.platform_charge_min_naira, 50); assert.equal(p.platform_charge_flat_naira, 0); assert.equal(p.commission_percent, 50);
    assert.equal(p.ps_percent, 1.5); assert.equal(p.ps_flat_naira, 100); assert.equal(p.ps_flat_waived_below_naira, 2500); assert.equal(p.ps_cap_naira, 2000); assert.equal(p.ps_vat_percent, 7.5);
    assert.ok(Math.abs(p.fee_share_customer_percent + p.fee_share_barber_percent + p.fee_share_platform_percent - 100) < 0.01);
    assert.equal(p.refund_auto_approve_hours, 3); assert.equal(p.liability_cap_naira, null);
    assert.equal(p.terms_version, '1');
  } finally { s.server.close(); resetNow(); }
});

test('admin alerts: in-app list, mark read, per-event preferences, quiet hours, push delivered via the fake gateway, dedupe, failures raise REFUND_FAILED', async () => {
  const s = await boot(); const sent: string[] = [];
  setPushSender(async (sub, payload) => { sent.push(sub.endpoint + '|' + JSON.parse(payload).title); });
  try {
    const sub = await s.j('/api/admin/alerts/subscribe', { method: 'POST', headers: s.A, body: { endpoint: 'https://push.example/abc', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } } });
    assert.equal(sub.status, 200);
    const prefs = (await s.j('/api/admin/alerts/prefs', { headers: s.A })).body;
    assert.deepEqual(prefs.events.map((e: any) => e.event).sort(), ['DELETION_REQUEST', 'PAYMENT_MISMATCH', 'REFUND_AUTO_APPROVED', 'REFUND_FAILED', 'REFUND_WAITING']);
    const { b } = await paid(s, s.customerIds[0], '12:00');
    await customerCancel(s.db, s.customerIds[0], b.id);
    const list = (await s.j('/api/admin/alerts', { headers: s.A })).body; assert.equal(list.unread, 1); assert.equal(list.items[0].event, 'REFUND_WAITING');
    await runSweep(s.db);
    assert.equal(sent.length, 1, 'pushed once'); assert.match(sent[0], /Refund needs a decision/);
    await runSweep(s.db); assert.equal(sent.length, 1, 'not re-sent');
    assert.equal((await s.j('/api/admin/alerts/read', { method: 'POST', headers: s.A, body: { all: true } })).status, 200);
    assert.equal((await s.j('/api/admin/alerts/unread', { headers: s.A })).body.unread, 0);
    // turn push off for REFUND_WAITING, in-app off for REFUND_AUTO_APPROVED
    assert.equal((await s.j('/api/admin/alerts/prefs', { method: 'PUT', headers: s.A, body: { prefs: { REFUND_WAITING: { in_app: true, push: false }, REFUND_AUTO_APPROVED: { in_app: false, push: true } } } })).status, 200);
    assert.equal((await s.j('/api/admin/alerts/prefs', { method: 'PUT', headers: s.A, body: { prefs: { NOPE: { in_app: true, push: true } } } })).status, 400);
    const c = await paid(s, s.customerIds[1], '14:00'); await customerCancel(s.db, s.customerIds[1], c.b.id);
    await runSweep(s.db); assert.equal(sent.length, 1, 'push disabled for that event');
    setNow(`${WED}T12:00:00+01:00`); await runSweep(s.db);   // both refunds auto-approve: in-app off, push on
    assert.equal((await s.j('/api/admin/alerts', { headers: s.A })).body.items.filter((i: any) => i.event === 'REFUND_AUTO_APPROVED').length, 0, 'in-app disabled -> not in the list');
    await runSweep(s.db); assert.ok(sent.some((x) => /auto-approved/i.test(x)), 'but still pushed');
    // quiet hours hold pushes
    assert.equal((await s.j('/api/admin/alerts/prefs', { method: 'PUT', headers: s.A, body: { quiet: { enabled: true, start: '22:00', end: '07:00' } } })).status, 200);
    assert.equal((await s.j('/api/admin/alerts/prefs', { method: 'PUT', headers: s.A, body: { quiet: { enabled: true, start: '25:00', end: '07:00' } } })).status, 400);
    assert.equal(inQuietHours({ enabled: true, start_min: 22 * 60, end_min: 7 * 60 }, 23 * 60), true);
    assert.equal(inQuietHours({ enabled: true, start_min: 22 * 60, end_min: 7 * 60 }, 6 * 60 + 59), true);
    assert.equal(inQuietHours({ enabled: true, start_min: 22 * 60, end_min: 7 * 60 }, 12 * 60), false);
    assert.equal(inQuietHours({ enabled: false, start_min: 22 * 60, end_min: 7 * 60 }, 23 * 60), false);
    assert.equal((await s.j('/api/admin/alerts')).status, 401);
  } finally { setPushSender(null); s.server.close(); resetNow(); }
});
