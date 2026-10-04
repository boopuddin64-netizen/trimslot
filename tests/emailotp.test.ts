import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, App } from './httpHelpers';
import { WED, setNow, unverifiedUsers } from './helpers';
import { setMailTransport, sendMail, mailerMode, Mail } from '../src/mailer';
import { fixedDevCode, hashCode, OTP_MAX_ATTEMPTS, OTP_SENDS_PER_IP_HOUR } from '../src/emailOtp';
import { createBooking } from '../src/bookingService';

const FLAG = 'EMAIL_VERIFICATION_REQUIRED';
const flagWas = process.env[FLAG];
const setFlag = (v: string | undefined) => { if (v === undefined) delete process.env[FLAG]; else process.env[FLAG] = v; };

/** The OTP rules are tested with the flag ON (it is OFF by default); bootOff() keeps the default. */
async function boot(flag: 'on' | 'off' = 'on') {
  setFlag(flag === 'on' ? 'true' : undefined);
  const c = await bootApp();
  await unverifiedUsers(c.db);                     // the real rules: new users start unverified
  const mails: Mail[] = []; setMailTransport(async (m) => { mails.push(m); });
  let n = 0;
  const signup = async (body: any) => {
    const r = await c.call('POST', '/api/auth/signup', { accept_terms: true, name: 'New Person', password: 'Password123', role: 'customer', ...body });
    const id = r.json?.user?.id as number;
    if (id && (body.role ?? 'customer') === 'customer') await c.db.query(`INSERT INTO customer_barbers (customer_id, barber_id, added, source, created_at) VALUES ($1,$2,TRUE,'link',now())`, [id, c.barberId]);   // the barber's link was opened
    return { r, cookie: r.headers.get('set-cookie')?.split(';')[0] as string, id };
  };
  const customer = async (extra: any = {}) => signup({ email: `new${++n}-${Date.now()}@example.com`, ...extra });
  const book = (cookie: string, time = '10:00') => c.call('POST', '/api/bookings', { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time, payment_option: 'ON_ARRIVAL' }, cookie);
  const done = () => { setMailTransport(null); setFlag(flagWas); c.close(); };
  return { c, mails, signup, customer, book, done };
}

test('email code: first booking is blocked until verified; code is 6 digits, only a hash is stored, 10 minute expiry, 5 tries', async () => {
  const { c, mails, customer, book, done } = await boot();
  try {
    const u = await customer();
    assert.equal(u.r.status, 201); assert.equal(u.r.json.user.email_verified, false);
    const blocked = await book(u.cookie);
    assert.equal(blocked.status, 403); assert.equal(blocked.json.error.code, 'EMAIL_NOT_VERIFIED');
    // send
    const s = await c.call('POST', '/api/auth/email/send', {}, u.cookie);
    assert.equal(s.status, 200, s.text); assert.equal(s.json.expires_in_min, 10);
    assert.equal(mails.length, 1); assert.match(mails[0].text, /\b123456\b/);       // dev/test fixed code (not production)
    const row = await c.db.one('SELECT otp_hash, otp_expires_at, otp_attempts FROM users WHERE id=$1', [u.id]);
    assert.match(row.otp_hash, /^[0-9a-f]{64}$/); assert.ok(!JSON.stringify(row).includes('123456'));
    assert.equal(row.otp_hash, hashCode(u.id, (await c.db.one('SELECT email FROM users WHERE id=$1', [u.id])).email, '123456'));
    // wrong code, bad format
    assert.equal((await c.call('POST', '/api/auth/email/verify', { code: '12ab' }, u.cookie)).status, 400);
    let r = await c.call('POST', '/api/auth/email/verify', { code: '000000' }, u.cookie);
    assert.equal(r.status, 400); assert.equal(r.json.error.code, 'OTP_WRONG'); assert.match(r.json.error.message, /4 tries left/);
    // 5 wrong tries lock the code, even the right one is then refused
    for (let i = 0; i < OTP_MAX_ATTEMPTS - 1; i++) r = await c.call('POST', '/api/auth/email/verify', { code: '000001' }, u.cookie);
    assert.match(r.json.error.message, /Too many wrong tries/);
    r = await c.call('POST', '/api/auth/email/verify', { code: '123456' }, u.cookie);
    assert.equal(r.status, 429); assert.equal(r.json.error.code, 'OTP_LOCKED');
    assert.equal((await c.call('GET', '/api/auth/me', undefined, u.cookie)).json.user.email_verified, false);
    // a new code resets the tries; but it expires after 10 minutes
    await c.call('POST', '/api/auth/email/send', {}, u.cookie);
    setNow(`${WED}T08:10:30+01:00`);
    r = await c.call('POST', '/api/auth/email/verify', { code: '123456' }, u.cookie);
    assert.equal(r.status, 400); assert.equal(r.json.error.code, 'OTP_EXPIRED');
    setNow(`${WED}T08:12:00+01:00`);
    await c.call('POST', '/api/auth/email/send', {}, u.cookie);   // 3rd code this hour (the limit)
    setNow(`${WED}T08:20:00+01:00`);
    r = await c.call('POST', '/api/auth/email/verify', { code: '123456' }, u.cookie);
    assert.equal(r.status, 200, r.text); assert.equal(r.json.user.email_verified, true);
    const after = await c.db.one('SELECT otp_hash, email_verified_at FROM users WHERE id=$1', [u.id]);
    assert.equal(after.otp_hash, null); assert.ok(after.email_verified_at);
    setNow(`${WED}T08:20:00+01:00`);
    const ok = await book(u.cookie, '11:00');
    assert.equal(ok.status, 201, ok.text);
  } finally { done(); }
});

test('email code: resend limit 3 per hour per email, and a cap per network', async () => {
  const { c, customer, done } = await boot();
  try {
    const u = await customer();
    for (let i = 0; i < 3; i++) assert.equal((await c.call('POST', '/api/auth/email/send', {}, u.cookie)).status, 200);
    const r = await c.call('POST', '/api/auth/email/send', {}, u.cookie);
    assert.equal(r.status, 429); assert.equal(r.json.error.code, 'RATE_LIMITED');
    // network cap: 60 per hour in total. The 3 sends above already counted for this network; push the counter to 59, so exactly one more passes.
    assert.equal(OTP_SENDS_PER_IP_HOUR, 60);
    assert.equal(await c.db.maybeOne<any>(`SELECT 1 x FROM rate_limits WHERE key LIKE 'otp_send:ip:%'`).then((x) => !!x), true);
    await c.db.query(`UPDATE rate_limits SET hits=59 WHERE key LIKE 'otp_send:ip:%'`);
    const x1 = await customer(); assert.equal((await c.call('POST', '/api/auth/email/send', {}, x1.cookie)).status, 200, 'the 60th code from this network still works');
    const x2 = await customer(); assert.equal((await c.call('POST', '/api/auth/email/send', {}, x2.cookie)).status, 429, 'the 61st is stopped by the per-network cap');
  } finally { done(); }
});

test('email code: phone-only customers must add + verify an email; changing the email makes it unverified again', async () => {
  const { c, mails, signup, book, done } = await boot();
  try {
    const u = await signup({ phone: '08077770001' });
    assert.equal(u.r.status, 201);
    let r = await book(u.cookie);
    assert.equal(r.status, 403); assert.equal(r.json.error.code, 'EMAIL_NOT_VERIFIED'); assert.equal(r.json.error.details.needs_email, true); assert.match(r.json.error.message, /Add your email/);
    assert.equal((await c.call('POST', '/api/auth/email/send', {}, u.cookie)).json.error.code, 'EMAIL_REQUIRED');
    assert.equal((await c.call('PATCH', '/api/me', { email: 'Phone.Only@Example.com' }, u.cookie)).status, 200);
    await c.call('POST', '/api/auth/email/send', {}, u.cookie);
    assert.equal(mails[mails.length - 1].to, 'phone.only@example.com');
    assert.equal((await c.call('POST', '/api/auth/email/verify', { code: '123456' }, u.cookie)).status, 200);
    assert.equal((await book(u.cookie)).status, 201);
    // change email -> unverified again, old code gone
    r = await c.call('PATCH', '/api/me', { email: 'another@example.com' }, u.cookie);
    assert.equal(r.json.user.email_verified, false);
    assert.equal((await c.db.one('SELECT otp_hash FROM users WHERE id=$1', [u.id])).otp_hash, null);
    // same email again does not reset
    await c.call('POST', '/api/auth/email/send', {}, u.cookie);
    await c.call('POST', '/api/auth/email/verify', { code: '123456' }, u.cookie);
    r = await c.call('PATCH', '/api/me', { name: 'Renamed Person', email: 'another@example.com' }, u.cookie);
    assert.equal(r.json.user.email_verified, true);
  } finally { done(); }
});

test('email code: existing users are not locked out (login works; a customer with a past booking can still book), but the emergency action needs a verified email', async () => {
  const { c, done } = await boot();
  try {
    const old = await createBooking(c.db, c.customerIds[0], { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' });
    await c.db.query(`UPDATE users SET email_verified_at=NULL WHERE id=$1`, [c.customerIds[0]]);
    const cc = await c.chidi();                                           // login works while unverified
    assert.equal((await c.call('GET', '/api/auth/me', undefined, cc)).json.user.email_verified, false);
    const nb = await c.call('POST', '/api/bookings', { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time: '12:00', payment_option: 'ON_ARRIVAL' }, cc);
    assert.equal(nb.status, 201, nb.text);                                // grandfathered by history
    setNow(`${WED}T09:45:00+01:00`);
    await c.db.query(`UPDATE bookings SET payment_status='PAID', payment_option='ONLINE', paid_at=now() WHERE id=$1`, [old.id]);
    const h = await c.call('POST', `/api/bookings/${old.id}/help`, { note: 'Please help me' }, cc);
    assert.equal(h.status, 403); assert.equal(h.json.error.code, 'EMAIL_NOT_VERIFIED');
    await c.db.query(`UPDATE users SET email_verified_at=now() WHERE id=$1`, [c.customerIds[0]]);
    assert.equal((await c.call('POST', `/api/bookings/${old.id}/help`, { note: 'Please help me' }, cc)).status, 201);
  } finally { done(); }
});

test('email code: new barbers must give an email and verify it before the shop is bookable; barbers from before are exempt', async () => {
  const { c, signup, customer, book, done } = await boot();
  try {
    const noEmail = await signup({ role: 'barber', shop_name: 'No Mail Cuts', phone: '08077770002', accept_barber_agreement: true });
    assert.equal(noEmail.r.status, 400);
    const b = await signup({ role: 'barber', shop_name: 'New Cuts', email: 'newbarber@example.com', accept_barber_agreement: true });
    assert.equal(b.r.status, 201); assert.equal(b.r.json.user.email_verified, false);
    const bid = (await c.db.one('SELECT id FROM barbers WHERE user_id=$1', [b.id])).id;
    await c.db.query(`UPDATE barbers SET verified=TRUE, share_code='abcdef123456abcd' WHERE id=$1`, [bid]);       // approved by staff
    const svc = (await c.db.one(`INSERT INTO services (barber_id,name,price_kobo,duration_min,active,created_at) VALUES ($1,'Cut',200000,30,TRUE,now()) RETURNING id`, [bid])).id;
    const cu = await customer(); await c.db.query(`INSERT INTO customer_barbers (customer_id, barber_id, added, source, created_at) VALUES ($1,$2,TRUE,'link',now())`, [cu.id, bid]); await c.call('POST', '/api/auth/email/send', {}, cu.cookie); await c.call('POST', '/api/auth/email/verify', { code: '123456' }, cu.cookie);
    const tryBook = () => c.call('POST', '/api/bookings', { barber_id: bid, service_id: svc, date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' }, cu.cookie);
    let r = await tryBook();
    assert.equal(r.status, 409); assert.equal(r.json.error.code, 'BARBER_NOT_READY');
    await c.call('POST', '/api/auth/email/send', {}, b.cookie);
    assert.equal((await c.call('POST', '/api/auth/email/verify', { code: '123456' }, b.cookie)).status, 200);
    r = await tryBook(); assert.equal(r.status, 201, r.text);
    // the seeded (older) barber is exempt even when unverified
    await c.db.query(`UPDATE users SET email_verified_at=NULL, email_verify_exempt=TRUE WHERE email='mike@trimslot.demo'`);
    assert.equal((await book(cu.cookie, '14:00')).status, 201);
  } finally { done(); }
});

test('mailer: nothing real is sent from tests; production without a provider key refuses safely and never uses the fixed code', async () => {
  setMailTransport(null);
  assert.equal(mailerMode(), 'log');                               // test env: log transport, never a provider
  const prev = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.equal(fixedDevCode(), false);
    assert.equal(mailerMode(), 'none');
    await assert.rejects(sendMail({ to: 'a@b.co', subject: 's', text: 't' }), (e: any) => e.code === 'EMAIL_NOT_CONFIGURED');
  } finally { process.env.NODE_ENV = prev; }
  process.env.RESEND_API_KEY = 're_fake'; try { assert.equal(fixedDevCode(), false); assert.equal(mailerMode(), 'log'); } finally { delete process.env.RESEND_API_KEY; }   // NODE_ENV=test never reaches Resend
});

test('email code PAUSED (flag off, the default): nothing is blocked, nothing is sent, the OTP endpoints stay but refuse to send', async () => {
  const { c, mails, signup, customer, book, done } = await boot('off');
  try {
    assert.equal((await c.call('GET', '/api/config')).json.email_verification, false);
    // sign-up works without any code; a barber may sign up without an email again
    const u = await customer();
    assert.equal(u.r.status, 201);
    assert.equal((await signup({ role: 'barber', shop_name: 'Phone Cuts', phone: '08077770003', accept_barber_agreement: true })).r.status, 201);
    // first-time customer books without a verified email
    assert.equal((await c.db.one('SELECT email_verified_at FROM users WHERE id=$1', [u.id])).email_verified_at, null);
    const first = await book(u.cookie);
    assert.equal(first.status, 201, first.text);
    // a brand-new barber (not verified, not exempt) is bookable
    const b = await signup({ role: 'barber', shop_name: 'New Cuts', email: 'newbarber@example.com', accept_barber_agreement: true });
    const bid = (await c.db.one('SELECT id FROM barbers WHERE user_id=$1', [b.id])).id;
    await c.db.query(`UPDATE barbers SET verified=TRUE, share_code='abcdef123456abcd' WHERE id=$1`, [bid]);
    const svc = (await c.db.one(`INSERT INTO services (barber_id,name,price_kobo,duration_min,active,created_at) VALUES ($1,'Cut',200000,30,TRUE,now()) RETURNING id`, [bid])).id;
    await c.db.query(`INSERT INTO customer_barbers (customer_id, barber_id, added, source, created_at) VALUES ($1,$2,TRUE,'link',now())`, [u.id, bid]);
    assert.equal((await c.call('GET', `/api/barbers/${bid}`, undefined, u.cookie)).json.booking.paused, false);
    const nb = await c.call('POST', '/api/bookings', { barber_id: bid, service_id: svc, date: WED, time: '14:00', payment_option: 'ON_ARRIVAL' }, u.cookie);
    assert.equal(nb.status, 201, nb.text);
    // emergency help is allowed for an unverified customer
    setNow(`${WED}T09:45:00+01:00`);
    await c.db.query(`UPDATE bookings SET payment_status='PAID', payment_option='ONLINE', paid_at=now() WHERE id=$1`, [first.json.booking.id]);
    const h = await c.call('POST', `/api/bookings/${first.json.booking.id}/help`, { note: 'Please help me' }, u.cookie);
    assert.equal(h.status, 201, h.text);
    // the endpoints are still there but send nothing
    const s = await c.call('POST', '/api/auth/email/send', {}, u.cookie);
    assert.equal(s.status, 409); assert.equal(s.json.error.code, 'EMAIL_VERIFICATION_OFF');
    assert.equal((await c.call('POST', '/api/auth/email/verify', { code: '123456' }, u.cookie)).status, 409);
    assert.equal(mails.length, 0);
    assert.equal((await c.db.one('SELECT otp_hash FROM users WHERE id=$1', [u.id])).otp_hash, null);
    // switching it on later enforces the rules again (nothing to migrate)
    setFlag('true');
    assert.equal((await c.call('GET', '/api/config')).json.email_verification, true);
    assert.equal((await c.call('POST', '/api/auth/email/send', {}, u.cookie)).status, 200);
    assert.equal(mails.length, 1);
  } finally { done(); }
});
