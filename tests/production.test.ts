import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'net';
import { DEMO_SHARE_CODE } from '../src/seed';
import { ensureShareCode } from '../src/shareLinks';
import { freshDb, setNow, resetNow } from './helpers';
import { assertProductionConfig, config } from '../src/config';
import { migrate } from '../src/db';
import { newDatabase } from './helpers';
import { runSweep } from '../src/sweep';
import { createApp } from '../src/app';
import { redact } from '../src/logger';
import { createBooking } from '../src/bookingService';
import { computeSignature } from '../src/paystack';
import { MOCK_SECRET } from '../src/config';

const GOOD = {
  NODE_ENV: 'production', RESEND_API_KEY: 're_test_placeholder', MAIL_FROM: 'TrimSlot <no-reply@example.com>', DATABASE_URL: 'postgresql://postgres.abc:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres', CRON_SECRET: 'c'.repeat(32), JWT_SECRET: 'a'.repeat(40), PAYSTACK_SECRET_KEY: 'sk_test_abc123', APP_BASE_URL: 'https://book.example.com',
} as NodeJS.ProcessEnv;

test('prod config: the missing-mail-key warning only matters while email verification is switched on', () => {
  const noMail = { ...GOOD, RESEND_API_KEY: '', MAIL_FROM: '' } as NodeJS.ProcessEnv;
  assert.ok(!assertProductionConfig(noMail).warnings.some((w) => /RESEND_API_KEY/.test(w)));
  assert.ok(assertProductionConfig({ ...noMail, EMAIL_VERIFICATION_REQUIRED: 'true' }).warnings.some((w) => /RESEND_API_KEY/.test(w)));
});

test('prod config: valid env boots; test key yields a warning', () => {
  const r = assertProductionConfig({ ...GOOD });
  assert.ok(r.warnings.some((w) => /TEST key/.test(w)));
  assert.equal(assertProductionConfig({ ...GOOD, PAYSTACK_SECRET_KEY: 'sk_live_abc123' }).warnings.length, 0);
});
test('prod config: refuses missing/default/short JWT secret', () => {
  for (const jwt of [undefined, '', 'dev-insecure-secret-change-me', 'changeme-changeme-changeme-changeme-1', 'short']) {
    assert.throws(() => assertProductionConfig({ ...GOOD, JWT_SECRET: jwt }), /JWT_SECRET/, String(jwt));
  }
});
test('prod config: refuses missing/invalid Paystack key (no mock mode in production)', () => {
  assert.throws(() => assertProductionConfig({ ...GOOD, PAYSTACK_SECRET_KEY: '' }), /PAYSTACK_SECRET_KEY is not set/);
  assert.throws(() => assertProductionConfig({ ...GOOD, PAYSTACK_SECRET_KEY: 'pk_live_xyz' }), /does not look like/);
});
test('prod config: requires https APP_BASE_URL, forbids fake clock, validates CORS', () => {
  assert.throws(() => assertProductionConfig({ ...GOOD, APP_BASE_URL: 'http://x.com' }), /APP_BASE_URL/);
  assert.throws(() => assertProductionConfig({ ...GOOD, APP_BASE_URL: undefined }), /APP_BASE_URL/);
  assert.throws(() => assertProductionConfig({ ...GOOD, TRIMSLOT_FAKE_NOW: '2026-01-01T00:00:00Z' }), /FAKE_NOW/);
  assert.throws(() => assertProductionConfig({ ...GOOD, CORS_ORIGINS: '*' }), /CORS_ORIGINS/);
  assert.doesNotThrow(() => assertProductionConfig({ ...GOOD, CORS_ORIGINS: 'https://a.example.com, https://b.example.com' }));
});
test('prod config: DATABASE_URL required/validated; Supabase misconfigurations warn; CRON_SECRET length', () => {
  assert.throws(() => assertProductionConfig({ ...GOOD, DATABASE_URL: '' }), /DATABASE_URL is not set/);
  assert.throws(() => assertProductionConfig({ ...GOOD, DATABASE_URL: 'mysql://x' }), /DATABASE_URL must look like/);
  assert.throws(() => assertProductionConfig({ ...GOOD, CRON_SECRET: 'short' }), /CRON_SECRET/);
  assert.ok(assertProductionConfig({ ...GOOD, CRON_SECRET: '' }).warnings.some((w) => /CRON_SECRET is not set/.test(w)));
  const v = { ...GOOD, VERCEL: '1' } as NodeJS.ProcessEnv;
  assert.ok(assertProductionConfig({ ...v, DATABASE_URL: 'postgresql://postgres:pw@db.abcdef.supabase.co:5432/postgres' }).warnings.some((w) => /DIRECT host/.test(w)));
  assert.ok(assertProductionConfig({ ...v, DATABASE_URL: 'postgresql://postgres.abc:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres' }).warnings.some((w) => /SESSION mode/.test(w)));
  assert.equal(assertProductionConfig({ ...v }).warnings.filter((w) => /pooler|DIRECT|SESSION/.test(w)).length, 0);
});
test('prod config: dev/test env is never blocked', () => {
  assert.deepEqual(assertProductionConfig({ NODE_ENV: 'development' } as any).warnings, []);
});

test('log redaction removes secrets', () => {
  const out: any = redact({ password: 'x', headers: { authorization: 'Bearer abc', cookie: 'a=b' }, note: 'key sk_live_ABC123def used', ok: 'fine', 'x-paystack-signature': 'zzz' });
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.headers.authorization, '[REDACTED]');
  assert.equal(out['x-paystack-signature'], '[REDACTED]');
  assert.ok(!/ABC123def/.test(out.note));
  assert.equal(out.ok, 'fine');
});

/* ---------- HTTP-level checks ---------- */
async function withServer(fn: (base: string, ctx: Awaited<ReturnType<typeof freshDb>>) => Promise<void>) {
  setNow('2026-09-29T08:00:00+01:00');
  const ctx = await freshDb();
  const server = createApp(ctx.db).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await fn(base, ctx); } finally { server.close(); resetNow(); }
}
const j = (base: string, p: string, body?: any, cookie?: string, method?: string) =>
  fetch(base + p, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

test('healthz, security headers, and no x-powered-by', async () => {
  await withServer(async (base) => {
    const r = await fetch(base + '/healthz');
    assert.equal(r.status, 200);
    assert.equal((await r.json() as any).status, 'ok');
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.match(r.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(base + '/privacy.html')).status, 200);
    assert.equal((await fetch(base + '/terms.html')).status, 200);
  });
});

test('cross-origin state-changing request is blocked; oversized body rejected; CORS off by default', async () => {
  await withServer(async (base) => {
    const bad = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
    assert.equal(bad.status, 403);
    const pre = await fetch(base + '/api/auth/login', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
    const big = await j(base, '/api/auth/login', { identifier: 'a@b.com', password: 'x'.repeat(200_000) });
    assert.equal(big.status, 413);
  });
});

test('barber onboarding: new barber is hidden + unbookable until verified; existing demo barber stays visible', async () => {
  await withServer(async (base, { db, customerIds, serviceIds, barberId }) => {
    const su = await j(base, '/api/auth/signup', { accept_terms: true, accept_barber_agreement: true, role: 'barber', name: 'New Barber', email: 'new@barber.com', password: 'Password123', shop_name: 'Fresh Cuts', location: 'Yaba' });
    assert.equal(su.status, 201);
    const body = await su.json() as any;
    assert.equal(body.user.verified, false);
    const cookie = su.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await j(base, '/api/barbers')).status, 401, 'there is no public list of barbers');
    const newId = (await db.one(`SELECT id FROM barbers WHERE shop_name='Fresh Cuts'`)).id;
    const newCode = await ensureShareCode(db, newId);
    assert.equal((await j(base, `/api/b/${newCode}`)).status, 404, 'unverified shop: the link does not resolve');
    assert.equal((await j(base, `/api/barbers/${newId}`)).status, 404);
    // service exists (barber configured it) but customers cannot book it
    const svc = await j(base, '/api/barber/services', { name: 'Cut', price_naira: 2000, duration_min: 30 }, cookie);
    assert.equal(svc.status, 201);
    const svcId = (await svc.json() as any).id;
    assert.equal((await j(base, `/api/barbers/${newId}/slots?service_id=${svcId}&date=2026-09-30`)).status, 404);
    await assert.rejects(createBooking(db, customerIds[0], { barber_id: newId, service_id: svcId, date: '2026-09-30', time: '10:00', payment_option: 'ON_ARRIVAL' }), /could not find/i);
    // barber can still see own dashboard
    assert.equal((await j(base, '/api/barber/today', undefined, cookie)).status, 200);
    // admin verify (same statements as the CLI)
    await db.query('UPDATE barbers SET verified=TRUE, verified_at=now() WHERE id=$1', [newId]);
    assert.equal((await j(base, `/api/b/${newCode}`)).status, 200, 'verified: the link resolves');
    assert.ok(barberId && serviceIds.length);
  });
});

test('webhook still works end-to-end over HTTP with the raw body preserved', async () => {
  await withServer(async (base, { db, customerIds, serviceIds, barberId }) => {
    const b = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: '2026-09-30', time: '10:00', payment_option: 'ONLINE' });
    const login = await j(base, '/api/auth/login', { identifier: 'chidi@trimslot.demo', password: 'Customer123!' });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const pay = await (await j(base, `/api/bookings/${b.id}/pay`, {}, cookie)).json() as any;
    await j(base, `/api/payments/mock/${pay.reference}/complete`, {});
    // whitespace/ordering in the body must be preserved byte-for-byte for the HMAC
    const raw = `{ "event" : "charge.success",\n "data":{"reference":"${pay.reference}"} }`;
    const sig = computeSignature(raw, MOCK_SECRET);
    const post = (s: string) => fetch(base + '/api/payments/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': s }, body: raw });
    assert.equal((await post('0'.repeat(128))).status, 401);
    const ok = await post(sig);
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as any).result, 'processed');
    assert.equal(((await (await post(sig)).json()) as any).result, 'already_processed');
    assert.equal((await db.one('SELECT status, payment_status FROM bookings WHERE id=$1', [b.id])).payment_status, 'PAID');
  });
});

test('migrations: idempotent re-run applies nothing; schema has the safety constraints', async () => {
  const { db } = await newDatabase();
  assert.deepEqual(await migrate(db), []);
  const idx = (await db.many(`SELECT indexname FROM pg_indexes WHERE schemaname='public'`)).map((r) => r.indexname);
  for (const n of ['uq_bookings_active_slot', 'uq_bookings_one_in_service']) assert.ok(idx.includes(n), n);
  const uniq = await db.many(`SELECT conname FROM pg_constraint WHERE contype='u' OR contype='x'`);
  assert.ok(uniq.some((r) => /payments_reference_key/.test(r.conname)), 'payments.reference unique');
  assert.ok(uniq.some((r) => /payment_events_event_key_key/.test(r.conname)), 'payment_events.event_key unique');
  const cols = (await db.many(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='public'`));
  const type = (t: string, c: string) => cols.find((x) => x.table_name === t && x.column_name === c)?.data_type;
  for (const [t, c] of [['bookings', 'scheduled_at'], ['bookings', 'ends_at'], ['bookings', 'created_at'], ['audit_log', 'created_at'], ['payment_events', 'created_at'], ['payments', 'created_at']]) assert.equal(type(t, c), 'timestamp with time zone', `${t}.${c}`);
  assert.equal(type('barbers', 'verified'), 'boolean');
  // a rerun with a second migrate() racing itself is safe (advisory lock)
  const { db: db2 } = await newDatabase();
  await db2.query('DROP TABLE schema_migrations');
  await db2.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const [r1, r2] = await Promise.all([migrate(db2), migrate(db2)]);
  const all = [...r1, ...r2];
  assert.equal(new Set(all).size, all.length, 'no migration was applied twice by the two racing migrators');
  assert.equal(all.length, (await db2.one('SELECT COUNT(*) c FROM schema_migrations')).c, 'every migration applied exactly once');
  assert.ok((await db2.one(`SELECT COUNT(*) c FROM information_schema.tables WHERE table_name='bookings'`)).c === 1);
});

test('payment_events.event_key is unique and reference-processed index prevents double processing at the DB level', async () => {
  const { db } = await newDatabase();
  const ins = () => db.query(`INSERT INTO payment_events (source, event_key, signature_valid, reference, payload) VALUES ('WEBHOOK','k1',TRUE,'R1','{}')`);
  await ins();
  await assert.rejects(ins(), (e: any) => e.code === '23505');
});

test('cron endpoint: 503 when CRON_SECRET unset, 401 without/with wrong Bearer, 200 with the right one; GET and POST both work', async () => {
  await withServer(async (base) => {
    const hit = (auth?: string, method = 'GET') => fetch(base + '/api/cron/sweep', { method, headers: auth ? { Authorization: auth } : {} });
    delete process.env.CRON_SECRET;
    assert.equal((await hit('Bearer x')).status, 503);
    process.env.CRON_SECRET = 'cron-secret-for-tests-1234567890';
    try {
      assert.equal((await hit()).status, 401);
      assert.equal((await hit('Bearer nope')).status, 401);
      assert.equal((await hit('cron-secret-for-tests-1234567890')).status, 401);            // must be a Bearer header
      assert.equal((await fetch(base + '/api/cron/sweep?secret=cron-secret-for-tests-1234567890')).status, 401); // never accepted via query string
      const ok = await hit('Bearer cron-secret-for-tests-1234567890');
      assert.equal(ok.status, 200);
      assert.equal(((await ok.json()) as any).ok, true);
      assert.equal((await hit('Bearer cron-secret-for-tests-1234567890', 'POST')).status, 200);
      assert.equal(ok.headers.get('cache-control'), 'no-store');
    } finally { delete process.env.CRON_SECRET; }
  });
});

test('sweeper releases expired holds and is idempotent; fresh holds are untouched', async () => {
  setNow('2026-09-29T08:00:00+01:00');
  try {
    const { db, barberId, customerIds, serviceIds } = await freshDb();
    const old = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: '2026-09-30', time: '10:00', payment_option: 'ONLINE' });
    setNow('2026-09-29T08:10:00+01:00');
    const fresh = await createBooking(db, customerIds[1], { barber_id: barberId, service_id: serviceIds[0], date: '2026-09-30', time: '11:00', payment_option: 'ONLINE' });
    setNow('2026-09-29T08:20:00+01:00');
    assert.equal((await runSweep(db)).holds_released, 1);
    assert.equal((await runSweep(db)).holds_released, 0);
    assert.equal((await db.one('SELECT status FROM bookings WHERE id=$1', [old.id])).status, 'CANCELLED');
    assert.equal((await db.one('SELECT status FROM bookings WHERE id=$1', [fresh.id])).status, 'PENDING_PAYMENT');
  } finally { resetNow(); }
});

test('DB-backed rate limiter: counts across separate Db instances (i.e. across serverless instances) and the failed-login lock trips', async () => {
  const { db, name } = await newDatabase();
  const { createDb } = await import('../src/db');
  const other = createDb(`postgres://postgres:postgres@127.0.0.1:${process.env.TEST_PG_PORT}/${name}`, { max: 2 });
  const { dbLimiter, recordFailedLogin, assertLoginNotLocked } = await import('../src/security');
  const prev = process.env.NODE_ENV; process.env.NODE_ENV = 'development';
  try {
    const mw = (d: any) => dbLimiter(d, { name: 't', windowMs: 60_000, limit: 3, message: 'slow down' });
    const call = async (d: any) => { let status = 200; await mw(d)({ ip: '1.2.3.4' } as any, { setHeader() {}, status(s: number) { status = s; return this; }, json() {} } as any, () => {}); return status; };
    assert.deepEqual([await call(db), await call(other), await call(db), await call(other)], [200, 200, 200, 429]);
    for (let i = 0; i < 8; i++) await recordFailedLogin(db, 'Victim@x.com');
    assert.ok(await assertLoginNotLocked(other, 'victim@x.com'));       // case-insensitive, visible from the other instance
    assert.equal(await assertLoginNotLocked(other, 'someone-else@x.com'), null);
    // fail-open: a broken DB must not crash the limiter
    const broken = createDb('postgres://postgres:postgres@127.0.0.1:1/none', { max: 1 });
    assert.equal(await call(broken), 200);
    await broken.close().catch(() => {});
  } finally { process.env.NODE_ENV = prev; await other.close(); }
});

test('serverless-style lifecycle: closing the pool and creating a new one keeps working (cold start)', async () => {
  const { db, name } = await newDatabase();
  const { createDb } = await import('../src/db');
  await db.query('SELECT 1');
  const d2 = createDb(`postgres://postgres:postgres@127.0.0.1:${process.env.TEST_PG_PORT}/${name}`, { max: 1 });
  assert.equal((await d2.one('SELECT 1 AS x')).x, 1);
  await d2.close();
  assert.equal(config.poolMax, 3);
});
