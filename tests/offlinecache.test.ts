/* Unit tests for the on-device read-only cache (public/offline-cache.js) and the network banner rules (public/net-banner.js). Pure logic, no DB, no browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const req = createRequire(__filename);
const OC: any = req('../public/offline-cache.js');
const NB: any = req('../public/net-banner.js');
const mk = (now = () => 1_000_000) => { const s = OC.memoryStorage(); return { s, c: OC.create(s, now) }; };
const me = (id: number, extra: any = {}) => ({ user: { id, role: 'customer', name: 'User ' + id, email: `u${id}@x.test`, ...extra } });
const personal = (s: any) => Object.keys(s).length;
const keys = (s: any) => { const o: string[] = []; for (let i = 0; i < s.length; i++) o.push(s.key(i)); return o; };

test('only the read-only allow-list can be saved; writes and other calls are refused', () => {
  const { c } = mk(); c.save('/auth/me', me(1));
  for (const p of ['/auth/login', '/auth/signup', '/auth/email/verify', '/bookings/5', '/bookings/5/pay', '/me/wallet/buy', '/payments/callback', '/barber/payout', '/admin/home', '/push/subscribe', '/notifications'])
    assert.equal(c.save(p, { x: 1 }), false, p);
  assert.equal(OC.isReadable('POST', '/bookings'), false);
  assert.equal(OC.isReadable('GET', '/bookings'), true);
  assert.equal(OC.isReadable('GET', '/bookings?x=1'), false);
  assert.equal(OC.isReadable('GET', '/me/barbers'), true);
  assert.equal(OC.isReadable('GET', '/me/wallet'), true);
  assert.equal(OC.isReadable('GET', '/me'), false);
});

test('saved data is scoped to the signed-in user', () => {
  const { s, c } = mk();
  c.save('/auth/me', me(7)); c.save('/bookings', { bookings: [{ id: 1 }] });
  assert.ok(keys(s).includes('ts_oc1:7:/bookings'));
  assert.deepEqual(c.load('/bookings').d, { bookings: [{ id: 1 }] });
  // a second "page load" (fresh object, same storage) reads the last user's copy
  const c2 = OC.create(s, () => 1_000_001);
  assert.deepEqual(c2.load('/bookings').d, { bookings: [{ id: 1 }] });
  assert.equal(c2.load('/me/barbers'), null);
});

test('account change wipes the previous account\'s data first', () => {
  const { s, c } = mk();
  c.save('/auth/me', me(1)); c.save('/bookings', { bookings: [{ id: 1 }] }); c.save('/me/barbers', { barbers: [{ id: 3 }] });
  c.save('/auth/me', me(2));
  assert.equal(c.load('/bookings'), null);
  assert.ok(!keys(s).some((k) => k.startsWith('ts_oc1:1:')));
  c.save('/bookings', { bookings: [{ id: 9 }] });
  assert.ok(keys(s).includes('ts_oc1:2:/bookings'));
});

test('clear() (logout) removes every personal entry and the remembered user; public settings may stay', () => {
  const { s, c } = mk();
  c.save('/config', { currency: 'NGN', today: '2026-09-30' });
  c.save('/auth/me', me(1)); c.save('/bookings', { bookings: [] }); c.save('/me/barbers', { barbers: [] });
  s.setItem('trimslot_theme', 'dark'); s.setItem('other', '1');
  c.clear();
  assert.deepEqual(keys(s).filter((k) => k.startsWith('ts_oc1:') && !k.startsWith('ts_oc1:g:')), []);
  assert.equal(c.lastUid(), null);
  assert.equal(c.load('/bookings'), null); assert.equal(c.load('/auth/me'), null);
  assert.equal(s.getItem('trimslot_theme'), 'dark'); assert.equal(s.getItem('other'), '1');   // never touches other keys
});

test('server says "nobody is signed in" -> everything personal is forgotten', () => {
  const { s, c } = mk();
  c.save('/auth/me', me(4)); c.save('/bookings', { bookings: [{ id: 1 }] });
  assert.equal(c.save('/auth/me', { user: null }), false);
  assert.equal(c.load('/bookings'), null);
  assert.ok(!keys(s).some((k) => /^ts_oc1:4:/.test(k)));
});

test('no tokens, passwords, one-time codes or payment references are ever written', () => {
  const { s, c } = mk();
  c.save('/auth/me', me(1, { token: 'jwt.aaa.bbb', password: 'hunter2', otp: '123456', email_otp_code: '1' }));
  c.save('/config', { email_dev_code: '123456', paystack_secret: 'sk_x', maintenance: null, features: { push: true }, vapid_public_key: 'BPub' });
  c.save('/me/barbers', { barbers: [{ id: 3, shop_name: 'S', share: { url: 'https://app/b/abcdef0123456789', code: 'abcdef0123456789' } }] });
  c.save('/bookings', { bookings: [{ id: 1, reference: 'TS-1-abc', authorization_url: 'https://pay/x', access_code: 'ac', price_kobo: 5000, money: { total_kobo: 5000 }, payment_status: 'PAID' }] });
  const all = keys(s).map((k) => s.getItem(k)).join('\n');
  for (const bad of ['jwt.aaa.bbb', 'hunter2', '123456', 'sk_x', 'TS-1-abc', 'https://pay/x', '"ac"', 'abcdef0123456789']) assert.ok(!all.includes(bad), 'leaked: ' + bad);
  assert.ok(all.includes('"price_kobo":5000') && all.includes('"payment_status":"PAID"'), 'normal fields are kept');
  assert.ok(all.includes('vapid_public_key'), 'public key (not a secret) is kept');
});

test('old (30 days) or oversized entries are dropped; broken storage never throws', () => {
  let t = 1_000_000; const { s, c } = mk(() => t);
  c.save('/auth/me', me(1)); c.save('/bookings', { bookings: [] });
  t += 31 * 86400000;
  assert.equal(c.load('/bookings'), null);
  t = 1_000_000; assert.equal(c.save('/bookings', { bookings: [{ note: 'x'.repeat(500_000) }] }), false);
  const bad = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); }, key() { return null; }, length: 0 };
  const cb = OC.create(bad);
  assert.equal(cb.save('/auth/me', me(1)), false); assert.equal(cb.load('/bookings'), null); cb.clear();
  s.setItem('ts_oc1:1:/bookings', '{not json'); c.use(1); assert.equal(c.load('/bookings'), null);
});

test('network banner picks the right short message', () => {
  assert.equal(NB.TEXT.offline, 'You are offline. Showing saved info.');
  assert.equal(NB.TEXT.slow, 'Slow connection.');
  assert.equal(NB.TEXT.retry, 'Taking long. Trying again.');
  assert.equal(NB.pick({ online: true, timedOut: false, slow: false }), null);
  assert.equal(NB.pick({ online: false, timedOut: true, slow: true }), 'offline');
  assert.equal(NB.pick({ online: true, timedOut: true, slow: true }), 'retry');
  assert.equal(NB.pick({ online: true, timedOut: false, slow: true }), 'slow');
  assert.equal(NB.isSlow({ effectiveType: '2g' }), true); assert.equal(NB.isSlow({ effectiveType: 'slow-2g' }), true);
  assert.equal(NB.isSlow({ effectiveType: '3g' }), false); assert.equal(NB.isSlow({ effectiveType: '4g', saveData: true }), true); assert.equal(NB.isSlow(undefined), false);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(NB.backoff), [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});
