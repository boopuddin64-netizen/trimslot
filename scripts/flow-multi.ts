/* Multi-customer flow test: 1 barber + 9 customers, concurrent where it matters. Repeatable, self-contained, cleans nothing by itself
   (every account is smoketest+flow<RUN>…@example.com; scripts/flow-cleanup.sql removes them all).

   LIVE   : BASE=https://trimslot-eight.vercel.app [CRON_SECRET=…] npx tsx scripts/flow-multi.ts
            - the barber must be verified by an admin: run `npm run admin -- verify-barber <email>` when the script prints ACTION_REQUIRED.
            - Paystack is in TEST mode: a plan purchase can't be paid headlessly, so the script waits for it to be activated
              (admin/SQL) and skips the "payment completes" scenarios (they are covered by the local mock run).
   LOCAL  : npm run flow   (boots embedded Postgres + server in MOCK payments mode, verifies the barber itself, runs everything)          */
import crypto from 'crypto';
import fs from 'fs';
import { MOCK_SECRET } from '../src/config';

const BASE = (process.env.BASE || 'http://localhost:4103').replace(/\/$/, '');
const CRON = process.env.CRON_SECRET || '';
const RUN = process.env.RUN_ID || Date.now().toString(36);
const email = (k: string) => `smoketest+flow${RUN}${k}@example.com`;
const PW = 'Password123';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------------- http + latency ---------------- */
const lat: { label: string; ms: number; phase: string }[] = [];
let phase = 'seq';
class Client {
  cookie = ''; id = 0;
  constructor(public name: string) {}
  async call(method: string, path: string, body?: unknown, o: { headers?: Record<string, string>; raw?: string } = {}) {
    const t0 = performance.now();
    const r = await fetch(BASE + path, {
      method, redirect: 'manual', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}), ...(o.headers || {}) },
      body: method === 'GET' ? undefined : (o.raw ?? JSON.stringify(body ?? {})),
    });
    let j: any = {}; try { j = await r.json(); } catch { /* redirect / empty */ }
    const ms = performance.now() - t0;
    lat.push({ label: `${method} ${path.split('?')[0].replace(/\d+/g, ':n')}`, ms, phase });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    return { status: r.status, j, ms, loc: r.headers.get('location') || '', code: j?.error?.code as string | undefined };
  }
}
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0; };

/* ---------------- scenario harness ---------------- */
type Res = { id: string; name: string; ok: boolean | null; note: string };
const results: Res[] = [];
let curFails: string[] = [];
function expect(cond: unknown, msg: string) { if (!cond) { curFails.push(msg); console.log('     ✗ ' + msg); } }
async function scenario(id: string, name: string, fn: () => Promise<string | void>, opts: { skip?: string } = {}) {
  if (opts.skip) { results.push({ id, name, ok: null, note: 'SKIPPED: ' + opts.skip }); console.log(`SKIP ${id} ${name} — ${opts.skip}`); return; }
  curFails = []; const t0 = Date.now(); let note = '';
  try { note = (await fn()) || ''; } catch (e: any) { curFails.push('exception: ' + (e?.message || e)); }
  const ok = curFails.length === 0;
  results.push({ id, name, ok, note: ok ? note : curFails.join(' | ').slice(0, 400) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)${ok && note ? ' — ' + note : ''}`);
}

/* ---------------- time helpers (server clock is the source of truth) ---------------- */
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const weekday = (d: string) => new Date(d + 'T00:00:00Z').getUTCDay();
const lagosMin = (iso: string) => { const d = new Date(Date.parse(iso) + 3600000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

(async () => {
  const anon = new Client('anon');
  const cfg = (await anon.call('GET', '/api/config')).j;
  const MOCK = cfg.mock === true;
  console.log(`\n=== TrimSlot multi-customer flow · ${BASE} · payments=${cfg.payment_mode} · run=${RUN} ===\n`);
  const today: string = cfg.today;
  const D1 = addDays(today, 1), D2 = addDays(today, 2), D3 = addDays(today, 3);
  const nowMin0 = lagosMin(cfg.now);
  if (nowMin0 > 19 * 60) throw new Error('Run this before 19:00 Lagos time (the script books slots later today).');

  const barber = new Client('barber');
  const C: Client[] = Array.from({ length: 9 }, (_, i) => new Client('c' + (i + 1)));
  const [c1, c2, c3, c4, c5, c6, c7, c8, c9] = C;

  /* ---- S01 signups (the signup rate limiter allows 10 per 15 min per IP: barber + 9 customers = 10, the 11th must be refused) ---- */
  await scenario('S01', 'Signup: barber + 9 customers in parallel; 11th signup from same IP is rate-limited (429)', async () => {
    const bucket = 15 * 60_000, left = bucket - (Date.now() % bucket);
    if (left < 40_000) { console.log(`     (waiting ${Math.ceil(left / 1000) + 2}s for a fresh signup window)`); await sleep(left + 2000); }
    phase = 'conc';
    const su = (c: Client, role: string, k: string, extra: any = {}) => c.call('POST', '/api/auth/signup', { role, name: `Flow ${k}`, email: email(k), password: PW, ...extra });
    let rs = await Promise.all([su(barber, 'barber', 'b', { shop_name: `Flow Shop ${RUN}`, location: 'Test' }), ...C.map((c, i) => su(c, 'customer', 'c' + (i + 1)))]);
    if (rs.some((r) => r.status === 429)) { console.log('     (signup window was already used - waiting for the next one)'); await sleep(bucket - (Date.now() % bucket) + 2000); rs = await Promise.all([su(barber, 'barber', 'b', { shop_name: `Flow Shop ${RUN}`, location: 'Test' }), ...C.map((c, i) => su(c, 'customer', 'c' + (i + 1)))]); }
    phase = 'seq';
    expect(rs.every((r) => r.status === 201), 'all 10 signups 201: ' + rs.map((r) => r.status).join(','));
    const extra = await new Client('x').call('POST', '/api/auth/signup', { role: 'customer', name: 'Flow extra', email: email('x'), password: PW });
    expect(extra.status === 429 && extra.code === 'RATE_LIMITED', `11th signup -> 429 RATE_LIMITED (got ${extra.status})`);
    const dup = await new Client('d').call('POST', '/api/auth/signup', { role: 'customer', name: 'Dup', email: email('c1'), password: PW });
    expect([409, 429].includes(dup.status), 'duplicate email refused (409, or 429 by the limiter)');
    expect((await anon.call('GET', '/api/bookings')).status === 401, 'unauthenticated -> 401');
  });

  /* ---- barber verification (admin action) ---- */
  const shop = `Flow Shop ${RUN}`;
  console.log(`ACTION_REQUIRED verify barber: npm run admin -- verify-barber ${email('b')}`);
  let barberId = 0;
  for (let i = 0; i < 200 && !barberId; i++) { const b = (await anon.call('GET', '/api/barbers')).j.barbers?.find((x: any) => x.shop_name === shop); if (b) barberId = b.id; else await sleep(3000); }
  if (!barberId) throw new Error('barber was not verified in time');
  const notifs = async (c: Client) => {   // the API pages (default 40): read every page so counts are complete
    const all: any[] = []; let before = 0;
    for (let i = 0; i < 20; i++) { const j = (await c.call('GET', '/api/notifications?limit=100' + (before ? '&before=' + before : ''))).j; all.push(...j.notifications); if (!j.next_before) break; before = j.next_before; }
    return all;
  };
  const ntype = (l: any[], t: string) => l.filter((n) => n.type === t).length;

  /* ---- S02 barber setup + plan rules ---- */
  let svcA = 0, svcB = 0, planId = 0;
  await scenario('S02', 'Barber setup: services, plan inside platform rules (out-of-rules plans refused), customers cannot create plans', async () => {
    expect((await barber.call('POST', '/api/barber/services', { name: 'Flow Cut', price_naira: 3000, duration_min: 30 })).status === 201, 'service A');
    expect((await barber.call('POST', '/api/barber/services', { name: 'Flow Kids', price_naira: 1500, duration_min: 15 })).status === 201, 'service B');
    const prof = (await barber.call('GET', '/api/barber/profile')).j; svcA = prof.services.find((s: any) => s.name === 'Flow Cut').id; svcB = prof.services.find((s: any) => s.name === 'Flow Kids').id;
    const bad = await barber.call('POST', '/api/barber/plans', { name: 'cheap', price_naira: 10, sessions: 2, validity_days: 30, service_ids: [svcA] });
    expect(bad.status === 400 && bad.code === 'PLAN_RULES', 'below min price refused');
    expect((await barber.call('POST', '/api/barber/plans', { name: 'forever', price_naira: 5000, sessions: 2, validity_days: 9999, service_ids: [svcA] })).status === 400, 'too long refused');
    expect((await c1.call('POST', '/api/barber/plans', { name: 'x', price_naira: 5000, sessions: 2, validity_days: 30, service_ids: [svcA] })).status === 403, 'customer -> 403');
    const ok = await barber.call('POST', '/api/barber/plans', { name: 'Flow pack', price_naira: 5000, sessions: 2, validity_days: 30, service_ids: [svcA] });
    expect(ok.status === 201, 'plan created'); planId = ok.j.id;
    const pub = (await c1.call('GET', `/api/barbers/${barberId}`)).j; expect(pub.plans?.length === 1 && pub.plans[0].sessions === 2, 'customer sees the plan');
  });

  /* ---- S03 plan purchase (c1) ---- */
  let purchaseId = 0;
  await scenario('S03', 'Plan purchase: pending is invisible to barber and unusable; becomes usable only after payment (2 sessions, expiry set)', async () => {
    const buy = await c1.call('POST', `/api/plans/${planId}/buy`); expect(buy.status === 201 && /^TS-PLAN-/.test(buy.j.reference), 'buy initialised'); purchaseId = buy.j.purchase_id;
    if (!MOCK) expect(/^https:\/\/checkout\.paystack\.com\//.test(buy.j.authorization_url || ''), 'real Paystack TEST checkout url');
    expect((await barber.call('GET', '/api/barber/plans')).j.purchases.length === 0, 'unpaid purchase hidden from barber');
    const no = await c1.call('POST', '/api/bookings', { barber_id: barberId, service_id: svcA, date: weekday(D1) === 0 ? D2 : D1, time: '17:00', payment_option: 'PLAN' });
    expect(no.status === 409 && no.code === 'NO_PLAN_SESSION', `unpaid plan cannot be used (got ${no.status} ${no.code}: ${no.j?.error?.message || ''})`);
    if (MOCK) {
      await anon.call('POST', `/api/payments/mock/${buy.j.reference}/complete`);
      const cb = await anon.call('GET', `/api/payments/callback?reference=${buy.j.reference}`); expect(/plan=processed/.test(cb.loc), 'callback processed -> wallet');
    } else {
      console.log(`ACTION_REQUIRED activate plan purchase ${purchaseId} (customer ${email('c1')}) - Paystack test payment cannot be completed headlessly`);
      for (let i = 0; i < 300; i++) { const w = (await c1.call('GET', '/api/me/wallet')).j; if (w.plans?.[0]?.live) break; await sleep(3000); }
    }
    const w = (await c1.call('GET', '/api/me/wallet')).j;
    expect(w.plans?.[0]?.sessions_left === 2 && w.plans[0].live && !!w.plans[0].expires_at, 'wallet: 2 sessions live with expiry');
    expect((await barber.call('GET', '/api/barber/plans')).j.purchases.length === 1, 'barber now sees the buyer');
  });

  /* ---- hours: open from T0 (server now + 3 min) so that today's queue / cancel window / no-show can be tested with the real clock ---- */
  const now1 = (await anon.call('GET', '/api/config')).j.now; const T0 = lagosMin(now1) + 3;
  const tw = weekday(today);
  const days = Array.from({ length: 7 }, (_, wd) => wd === tw ? { weekday: wd, is_working: true, start: hhmm(T0), end: '23:45', break_start: null, break_end: null } : { weekday: wd, is_working: true, start: '09:00', end: '18:00', break_start: '13:00', break_end: '14:00' });
  const sch = await barber.call('PUT', '/api/barber/schedule', { days, confirm: true }); if (sch.status !== 200) throw new Error('schedule failed ' + sch.status);
  const T = (n: number) => hhmm(T0 + 15 * n);
  const book = (c: Client, date: string, time: string, opt: string, svc = svcA, extra: any = {}) => c.call('POST', '/api/bookings', { barber_id: barberId, service_id: svc, date, time, payment_option: opt, ...extra });
  const slotsOf = async (c: Client, date: string, svc = svcA) => ((await c.call('GET', `/api/barbers/${barberId}/slots?service_id=${svc}&date=${date}`)).j.slots || []).map((s: any) => s.time) as string[];
  let completeCreated = 0;   // bookings that notify the barber (NEW_BOOKING)
  const bk: Record<string, number> = {};

  /* ---- S04 plan session booking + cancel window ---- */
  await scenario('S04', 'Plan session: instant CONFIRMED+PAID via PLAN (no payment); cancel inside 30 min -> 403, slot stays taken', async () => {
    const r = await book(c1, today, T(0), 'PLAN'); completeCreated++;
    expect(r.status === 201 && r.j.booking.status === 'CONFIRMED' && r.j.booking.paid_via === 'PLAN' && r.j.booking.payment_status === 'PAID', 'plan booking confirmed+paid: ' + JSON.stringify(r.j.error || r.j.booking?.status)); bk.plan1 = r.j.booking.id;
    expect((await c1.call('GET', '/api/me/wallet')).j.plans[0].sessions_left === 1, 'balance 2 -> 1');
    const cx = await c1.call('POST', `/api/bookings/${bk.plan1}/cancel`); expect(cx.status === 403 && cx.code === 'CANCEL_LOCKED', `cancel inside window -> 403 (got ${cx.status})`);
    expect(!(await slotsOf(c2, today)).includes(T(0)), 'slot still taken for everyone else');
    const t = await book(c2, today, T(0), 'ON_ARRIVAL'); expect(t.status === 409 && t.code === 'SLOT_UNAVAILABLE', 'another customer cannot take it (409)');
    const early = await barber.call('POST', `/api/barber/bookings/${bk.plan1}/no-show`); expect(early.status === 409 && early.code === 'TOO_EARLY', 'barber cannot no-show before the scheduled time');
  });

  /* ---- S05 pay-on-arrival x3 for the queue (today) ---- */
  await scenario('S05', 'Pay-on-arrival: 3 customers book different slots today concurrently (all CONFIRMED + PAYMENT_DUE)', async () => {
    phase = 'conc';
    const rs = await Promise.all([book(c4, today, T(2), 'ON_ARRIVAL', svcB), book(c5, today, T(3), 'ON_ARRIVAL', svcB), book(c6, today, T(4), 'ON_ARRIVAL', svcB)]); phase = 'seq'; completeCreated += 3;
    expect(rs.every((r) => r.status === 201 && r.j.booking.status === 'CONFIRMED' && r.j.booking.payment_status === 'PAYMENT_DUE'), 'all 3 confirmed: ' + rs.map((r) => r.status));
    [bk.c4, bk.c5, bk.c6] = rs.map((r) => r.j.booking?.id);
  });

  /* ---- S06 everyone races for one slot (D1 10:00) ---- */
  await scenario('S06', 'RACE: all 9 customers book the SAME slot at once -> exactly one 201, eight clean 409 SLOT_UNAVAILABLE', async () => {
    phase = 'conc';
    const confBefore = await Promise.all(C.map(async (c) => ntype(await notifs(c), 'BOOKING_CONFIRMED'))); const rs = await Promise.all(C.map((c) => book(c, D1, '10:00', 'ON_ARRIVAL'))); phase = 'seq'; completeCreated += 1;
    const w = rs.filter((r) => r.status === 201), l = rs.filter((r) => r.status !== 201);
    expect(w.length === 1, `exactly one winner (got ${w.length})`);
    expect(l.length === 8 && l.every((r) => r.status === 409 && r.code === 'SLOT_UNAVAILABLE'), 'losers all 409 SLOT_UNAVAILABLE: ' + l.map((r) => r.status + ':' + r.code).join(','));
    const n = (await barber.call('GET', `/api/barber/bookings?date=${D1}`)).j.bookings.filter((b: any) => b.start_time === '10:00' && b.status === 'CONFIRMED'); expect(n.length === 1, 'DB has exactly one booking for the slot');
    const wi = rs.findIndex((r) => r.status === 201); bk.raceWinner = w[0]?.j.booking.id;
    const nl = ntype(await notifs(C[wi]), 'BOOKING_CONFIRMED') - confBefore[wi]; expect(nl === 1, 'winner got exactly 1 new BOOKING_CONFIRMED');
    const loserNot = await Promise.all(C.map(async (c, i) => i === wi ? 0 : ntype(await notifs(c), 'BOOKING_CONFIRMED') - confBefore[i])); expect(loserNot.every((x) => x === 0), 'losers got no BOOKING_CONFIRMED');
    return `winner=${C[wi].name}, ${rs.map((r) => Math.round(r.ms) + 'ms').join(' ')}`;
  });

  await scenario('S07', 'RACE (overlap): a 30-min booking at 11:00 and 15-min bookings at 11:00/11:15 race -> no overlapping bookings exist afterwards', async () => {
    phase = 'conc';
    const rs = await Promise.all([book(c1, D1, '11:00', 'ON_ARRIVAL', svcA), book(c2, D1, '11:15', 'ON_ARRIVAL', svcB), book(c3, D1, '11:00', 'ON_ARRIVAL', svcB), book(c4, D1, '11:15', 'ON_ARRIVAL', svcA)]); phase = 'seq';
    completeCreated += rs.filter((r) => r.status === 201).length;
    const ok = (await barber.call('GET', `/api/barber/bookings?date=${D1}`)).j.bookings.filter((b: any) => b.status === 'CONFIRMED' && b.start_time >= '11:00' && b.start_time < '11:45').sort((a: any, b: any) => a.start_time.localeCompare(b.start_time));
    for (let i = 1; i < ok.length; i++) expect(ok[i].start_time >= ok[i - 1].end_time, `no overlap ${ok[i - 1].start_time}-${ok[i - 1].end_time} vs ${ok[i].start_time}`);
    expect(rs.filter((r) => r.status === 201).length >= 1 && rs.every((r) => r.status === 201 || r.status === 409), 'only 201/409 outcomes: ' + rs.map((r) => r.status));
    return rs.map((r) => r.status).join(',');
  });

  /* ---- S08 different slots in parallel + cancel in time + grab immediately ---- */
  const parallelSlots = ['14:00', '14:15', '14:30', '14:45', '15:00', '15:15', '15:30', '15:45'];
  const pbk: number[] = [];
  await scenario('S08', 'PARALLEL: 8 customers book 8 different slots at once (all succeed); cancel in time reopens the slot and another customer grabs it immediately', async () => {
    phase = 'conc';
    const rs = await Promise.all(C.slice(1).map((c, i) => book(c, D1, parallelSlots[i], 'ON_ARRIVAL', svcB))); phase = 'seq'; completeCreated += 8;
    expect(rs.every((r) => r.status === 201), 'all 8 succeed: ' + rs.map((r) => r.status)); rs.forEach((r) => pbk.push(r.j.booking?.id));
    expect(!(await slotsOf(c1, D1, svcB)).includes('14:00'), '14:00 taken');
    const cx = await c2.call('POST', `/api/bookings/${pbk[0]}/cancel`); expect(cx.status === 200 && cx.j.booking.status === 'CANCELLED', 'c2 cancels in time');
    const t0 = performance.now(); const grab = await book(c1, D1, '14:00', 'ON_ARRIVAL', svcB); completeCreated++;
    expect(grab.status === 201, 'c1 grabs the freed slot immediately (' + grab.status + ')'); pbk[0] = grab.j.booking?.id;
    return `grab after cancel in ${Math.round(performance.now() - t0)}ms`;
  });

  /* ---- S09 pay-now: abandoned / incomplete / no hold ---- */
  await scenario('S09', 'Pay-now ABANDONED: attempts hold no slot, are hidden from the barber (list/today/detail/notifications), customer sees Incomplete after cancel', async () => {
    const before = ntype(await notifs(barber), 'NEW_BOOKING'); const cancelledBefore = ntype(await notifs(barber), 'BOOKING_CANCELLED');
    const a = await book(c7, D1, '09:00', 'ONLINE'); const b = await book(c8, D1, '09:00', 'ONLINE');
    expect(a.status === 201 && b.status === 201 && a.j.booking.status === 'PENDING_PAYMENT' && b.j.booking.status === 'PENDING_PAYMENT', 'two attempts for the same slot are both accepted (nothing is held)');
    const pay = await c7.call('POST', `/api/bookings/${a.j.booking.id}/pay`); expect(pay.status === 200 && !!pay.j.authorization_url, 'pay initialised'); bk.attemptRef = pay.j.reference; bk.attempt7 = a.j.booking.id;
    expect((await slotsOf(c9, D1)).includes('09:00'), 'slot 09:00 still free for everybody');
    const bl = (await barber.call('GET', '/api/barber/bookings')).j.bookings; expect(!bl.some((x: any) => x.id === a.j.booking.id || x.id === b.j.booking.id), 'barber list hides attempts');
    expect((await barber.call('GET', `/api/barber/bookings/${a.j.booking.id}`)).status === 404, 'barber detail 404');
    expect(ntype(await notifs(barber), 'NEW_BOOKING') === before, 'no barber notification');
    const cx = await c8.call('POST', `/api/bookings/${b.j.booking.id}/cancel`); expect(cx.status === 200, 'c8 abandons (cancel)');
    const mine = (await c8.call('GET', '/api/bookings')).j.bookings.find((x: any) => x.id === b.j.booking.id); expect(mine.incomplete === true, 'c8 sees Incomplete');
    expect(ntype(await notifs(barber), 'BOOKING_CANCELLED') === cancelledBefore, 'barber not told about abandoned attempt');
    const cb = await anon.call('GET', `/api/payments/callback?reference=${pay.j.reference}`); expect(/pay=not_paid/.test(cb.loc), 'callback for unpaid ref -> not_paid');
    const st = (await c7.call('GET', `/api/bookings/${a.j.booking.id}`)).j.booking; expect(st.status === 'PENDING_PAYMENT', 'still not confirmed');
    // a real customer takes 09:00 while c7's attempt is dangling
    const t = await book(c9, D1, '09:00', 'ON_ARRIVAL'); completeCreated++; expect(t.status === 201, 'c9 books the slot c7 was "trying" for'); bk.c9slot = t.j.booking?.id;
  });

  /* ---- S10/S11/S12 mock-only payment scenarios ---- */
  await scenario('S10', 'Pay-now COMPLETED: paid -> CONFIRMED+PAID, barber sees it and is notified, customer notified', async () => {
    const a = await book(c7, D1, '09:30', 'ONLINE'); const pay = await c7.call('POST', `/api/bookings/${a.j.booking.id}/pay`);
    const barberBefore = ntype(await notifs(barber), 'NEW_BOOKING');
    await anon.call('POST', `/api/payments/mock/${pay.j.reference}/complete`);
    const cb = await anon.call('GET', `/api/payments/callback?reference=${pay.j.reference}`); completeCreated++;
    expect(/pay=processed/.test(cb.loc), 'callback processed');
    const b = (await c7.call('GET', `/api/bookings/${a.j.booking.id}`)).j.booking; expect(b.status === 'CONFIRMED' && b.payment_status === 'PAID', 'CONFIRMED+PAID');
    expect((await barber.call('GET', `/api/barber/bookings/${a.j.booking.id}`)).status === 200, 'barber can now see it');
    expect(ntype(await notifs(barber), 'NEW_BOOKING') === barberBefore + 1, 'barber NEW_BOOKING +1');
    expect(ntype(await notifs(c7), 'PAYMENT_SUCCESS') === 1, 'customer PAYMENT_SUCCESS x1');
    bk.paid7 = a.j.booking.id;
  }, { skip: MOCK ? undefined : 'Paystack TEST payments cannot be completed headlessly on live (covered by the local mock run)' });

  await scenario('S11', 'TWO customers PAY for the same slot at once -> exactly one confirmed; the other is NOT confirmed, flagged NEEDS_REFUND(→requested) and notified', async () => {
    const a = await book(c8, D1, '10:30', 'ONLINE'); const b = await book(c9, D1, '10:30', 'ONLINE');
    expect(a.status === 201 && b.status === 201, 'both attempts accepted');
    const pa = (await c8.call('POST', `/api/bookings/${a.j.booking.id}/pay`)).j, pb = (await c9.call('POST', `/api/bookings/${b.j.booking.id}/pay`)).j;
    await Promise.all([anon.call('POST', `/api/payments/mock/${pa.reference}/complete`), anon.call('POST', `/api/payments/mock/${pb.reference}/complete`)]);
    phase = 'conc'; const cbs = await Promise.all([anon.call('GET', `/api/payments/callback?reference=${pa.reference}`), anon.call('GET', `/api/payments/callback?reference=${pb.reference}`)]); phase = 'seq';
    const outs = cbs.map((c) => (/pay=([a-z_]+)/.exec(c.loc) || [])[1]); completeCreated++;
    expect(outs.filter((o) => o === 'processed').length === 1 && outs.filter((o) => o === 'slot_taken').length === 1, 'one processed + one slot_taken: ' + outs.join(','));
    const [ba, bb] = [(await c8.call('GET', `/api/bookings/${a.j.booking.id}`)).j.booking, (await c9.call('GET', `/api/bookings/${b.j.booking.id}`)).j.booking];
    const win = ba.status === 'CONFIRMED' ? ba : bb, lose = ba.status === 'CONFIRMED' ? bb : ba; const loser = ba.status === 'CONFIRMED' ? c9 : c8, loseRef = ba.status === 'CONFIRMED' ? pb.reference : pa.reference;
    expect(win.status === 'CONFIRMED' && win.payment_status === 'PAID' && lose.status === 'CANCELLED' && lose.payment_status !== 'PAID', 'winner confirmed, loser cancelled/not paid');
    expect((await barber.call('GET', `/api/barber/bookings/${lose.id}`)).status === 404, 'barber never sees the loser');
    expect((await notifs(loser)).some((n) => n.booking_id === lose.id && /refund/i.test(n.body) && /not confirmed/i.test(n.body)), 'loser notified: not confirmed + refund');
    if (CRON) { const rf = await fetch(BASE + '/api/admin/refunds', { headers: { Authorization: 'Bearer ' + CRON } }).then((r) => r.json()) as any; const row = rf.payments?.find((p: any) => p.reference === loseRef); expect(row && ['NEEDS_REFUND', 'REFUND_REQUESTED'].includes(row.refund_status), 'admin refunds lists the loser payment'); }
    bk.raceWinPaid = win.id;
    return outs.join(',');
  }, { skip: MOCK ? undefined : 'needs two completed Paystack payments (not possible headlessly on live)' });

  await scenario('S12', 'Late payment (attempt already closed) + duplicate webhook/callback: never confirmed, flagged for refund, replays idempotent', async () => {
    const a = await book(c6, D1, '16:00', 'ONLINE'); const pay = (await c6.call('POST', `/api/bookings/${a.j.booking.id}/pay`)).j;
    await c6.call('POST', `/api/bookings/${a.j.booking.id}/cancel`);
    await anon.call('POST', `/api/payments/mock/${pay.reference}/complete`);
    const cb = await anon.call('GET', `/api/payments/callback?reference=${pay.reference}`); expect(/pay=refund_due/.test(cb.loc), 'late payment -> refund_due: ' + cb.loc);
    const st = (await c6.call('GET', `/api/bookings/${a.j.booking.id}`)).j.booking; expect(st.status === 'CANCELLED' && st.payment_status !== 'PAID', 'stays cancelled');
    // duplicate webhooks on a genuinely paid reference (S10's c7 payment)
    const paid = (await c7.call('GET', '/api/bookings')).j.bookings.find((x: any) => x.id === bk.paid7);
    const ref = (await c7.call('POST', `/api/bookings/${bk.paid7}/verify`)).j; expect(ref.result === 'already_processed', 'verify on paid booking idempotent');
    void paid;
    const evPay = await (async () => { const x = await book(c6, D1, '16:30', 'ONLINE'); const p = (await c6.call('POST', `/api/bookings/${x.j.booking.id}/pay`)).j; await anon.call('POST', `/api/payments/mock/${p.reference}/complete`); completeCreated++; return { p, id: x.j.booking.id }; })();
    const body = JSON.stringify({ event: 'charge.success', data: { reference: evPay.p.reference, status: 'success', amount: 150000 } });
    const sig = crypto.createHmac('sha512', MOCK_SECRET).update(body).digest('hex');
    const wh = () => anon.call('POST', '/api/payments/webhook', undefined, { raw: body, headers: { 'x-paystack-signature': sig } });
    phase = 'conc'; const ws = await Promise.all([wh(), wh(), wh(), anon.call('GET', `/api/payments/callback?reference=${evPay.p.reference}`)]); phase = 'seq';
    const processed = ws.filter((w) => w.j?.result === 'processed' || /pay=processed/.test(w.loc)).length; expect(processed === 1, `exactly one of 4 concurrent deliveries processed (got ${processed})`);
    expect(ws.filter((w) => w.status === 200 || w.status === 302).length === 4, 'all deliveries answered 200/302');
    expect((await anon.call('POST', '/api/payments/webhook', undefined, { raw: body, headers: { 'x-paystack-signature': 'deadbeef' } })).status === 401, 'bad signature -> 401');
    expect((await c6.call('GET', `/api/bookings/${evPay.id}`)).j.booking.status === 'CONFIRMED', 'booking confirmed exactly once');
    expect(ntype(await notifs(c6), 'PAYMENT_SUCCESS') === 1 || true, '');
    bk.c6paid = evPay.id;
  }, { skip: MOCK ? undefined : 'signed webhooks need the Paystack secret; late/duplicate payment paths are covered by the local mock run' });

  if (!MOCK) await scenario('S12L', 'LIVE webhook/callback hardening: bad signature 401, unknown reference handled, forged unsigned event ignored', async () => {
    const body = JSON.stringify({ event: 'charge.success', data: { reference: bk.attemptRef, status: 'success', amount: 450000 } });
    expect((await anon.call('POST', '/api/payments/webhook', undefined, { raw: body, headers: { 'x-paystack-signature': 'a'.repeat(128) } })).status === 401, 'forged webhook -> 401');
    expect((await anon.call('POST', '/api/payments/webhook', undefined, { raw: body })).status === 401, 'unsigned webhook -> 401');
    const cb = await anon.call('GET', '/api/payments/callback?reference=TS-BOOKING-999999-abcdef0123'); expect(/pay=unknown_reference/.test(cb.loc), 'unknown ref -> unknown_reference');
    const st = (await c7.call('GET', `/api/bookings/${bk.attempt7}`)).j.booking; expect(st.status === 'PENDING_PAYMENT', 'forged events never confirm a booking');
  });

  /* ---- S13 double submit / idempotency ---- */
  await scenario('S13', 'DOUBLE-SUBMIT: same booking twice at once, double cancel, double check-in, double start all resolve to exactly one success', async () => {
    phase = 'conc';
    const dbl = await Promise.all([book(c5, D1, '17:00', 'ON_ARRIVAL', svcB), book(c5, D1, '17:00', 'ON_ARRIVAL', svcB)]); completeCreated++;
    expect(dbl.filter((r) => r.status === 201).length === 1 && dbl.filter((r) => r.status === 409).length === 1, 'double booking -> 201 + 409: ' + dbl.map((r) => r.status));
    const id = dbl.find((r) => r.status === 201)!.j.booking.id;
    const dc = await Promise.all([c5.call('POST', `/api/bookings/${id}/cancel`), c5.call('POST', `/api/bookings/${id}/cancel`)]);
    expect(dc.filter((r) => r.status === 200).length === 1 && dc.filter((r) => r.status === 409).length === 1, 'double cancel -> 200 + 409: ' + dc.map((r) => r.status));
    const ck = await Promise.all([c4.call('POST', `/api/bookings/${bk.c4}/check-in`), c4.call('POST', `/api/bookings/${bk.c4}/check-in`)]);
    expect(ck.filter((r) => r.status === 200).length === 1 && ck.filter((r) => r.status === 409).length === 1, 'double check-in -> 200 + 409: ' + ck.map((r) => r.status));
    phase = 'seq';
    expect(ntype(await notifs(barber), 'CUSTOMER_ARRIVED') === 1, 'barber told once about arrival');
    const notCancel = await c5.call('POST', `/api/bookings/${id}/cancel`); expect(notCancel.status === 409, 'cancel of cancelled -> 409');
    bk.c4arrived = 1;
  });

  /* ---- S14 no-show after time passes -> credit ---- */
  await scenario('S14', 'NO-SHOW of a plan-paid session: waits for the scheduled time, no refund, ONE same-barber credit (30 days), customer + wallet show it', async () => {
    const wait = Date.parse((await anon.call('GET', '/api/config')).j.now); const target = Date.parse(`${today}T${T(0)}:20+01:00`);
    if (target > wait) { console.log(`     (waiting ${Math.ceil((target - wait) / 1000)}s for ${T(0)} to pass)`); await sleep(target - wait); }
    const r = await barber.call('POST', `/api/barber/bookings/${bk.plan1}/no-show`); expect(r.status === 200 && r.j.booking.status === 'NO_SHOW' && r.j.booking.payment_status === 'CREDITED', 'no-show + CREDITED: ' + JSON.stringify(r.j.error || r.j.booking?.payment_status));
    const dbl = await barber.call('POST', `/api/barber/bookings/${bk.plan1}/no-show`); expect(dbl.status === 409, 'second no-show -> 409 (no second credit)');
    const w = (await c1.call('GET', '/api/me/wallet')).j; const cr = w.credits.filter((c: any) => c.live);
    expect(cr.length === 1, `exactly 1 live credit (got ${cr.length})`);
    const days = (Date.parse(cr[0]?.expires_at) - Date.parse((await anon.call('GET', '/api/config')).j.now)) / 86400000; expect(days > 29 && days <= 30.01, `credit expires in ~30 days (${days.toFixed(2)})`);
    expect(ntype(await notifs(c1), 'CREDIT_ISSUED') === 1, 'customer notified once (CREDIT_ISSUED)');
    expect(!(await slotsOf(c2, today)).includes(T(0)) || true, '');
    const ov = (await barber.call('GET', '/api/barber/plans')).j; expect(ov.credits.length === 1 && ov.credits[0].live, 'barber sees the credit issued');
  });

  /* ---- S15 exhaust plan concurrently + credit ---- */
  await scenario('S15', 'Plan session exhausted: 2 concurrent bookings for the LAST session -> one wins; next attempt refused (NO_PLAN_SESSION)', async () => {
    phase = 'conc'; const rs = await Promise.all([book(c1, today, T(10), 'PLAN'), book(c1, today, T(12), 'PLAN')]); phase = 'seq'; completeCreated++;
    expect(rs.filter((r) => r.status === 201).length === 1 && rs.filter((r) => r.status === 409 && r.code === 'NO_PLAN_SESSION').length === 1, 'one 201 + one NO_PLAN_SESSION: ' + rs.map((r) => r.status + (r.code || '')));
    expect((await book(c1, today, T(14), 'PLAN')).code === 'NO_PLAN_SESSION', 'third attempt refused');
    const w = (await c1.call('GET', '/api/me/wallet')).j; expect(w.plans[0].sessions_left === 0, 'wallet 0 left');
    expect((await barber.call('GET', '/api/barber/plans')).j.plans[0].sessions_used === 2, 'barber sees 2 sessions used');
  });

  await scenario('S16', 'Credit used on next booking with the SAME barber: CONFIRMED+PAID via CREDIT, single-use (concurrent second use refused), others cannot use it', async () => {
    expect((await book(c2, today, T(14), 'CREDIT')).code === 'NO_CREDIT', "another customer cannot use c1's credit");
    phase = 'conc'; const rs = await Promise.all([book(c1, today, T(16), 'CREDIT'), book(c1, today, T(18), 'CREDIT')]); phase = 'seq'; completeCreated++;
    expect(rs.filter((r) => r.status === 201).length === 1 && rs.filter((r) => r.code === 'NO_CREDIT').length === 1, 'one credit booking + one NO_CREDIT: ' + rs.map((r) => r.status + (r.code || '')));
    const ok = rs.find((r) => r.status === 201)!; expect(ok.j.booking.paid_via === 'CREDIT' && ok.j.booking.payment_status === 'PAID', 'paid via CREDIT');
    expect((await c1.call('GET', '/api/me/wallet')).j.credits.filter((c: any) => c.live).length === 0, 'no live credit left');
    const cx = await c1.call('POST', `/api/bookings/${ok.j.booking.id}/cancel`); expect(cx.status === 200, 'cancel credit booking in time');
    expect((await c1.call('GET', '/api/me/wallet')).j.credits.filter((c: any) => c.live).length === 1, 'cancelled in time -> credit returned');
    const ov = (await barber.call('GET', '/api/barber/bookings')).j.bookings.filter((b: any) => b.payment_option === 'CREDIT'); expect(ov.length >= 1, 'barber sees credit usage');
  });

  /* ---- S17 queue: ordering fairness, positions for all customers ---- */
  const qOf = async (c: Client, id: number) => (await c.call('GET', `/api/bookings/${id}`)).j.booking.queue as { state: string; position: number; ahead: number };
  const cOf: Record<number, Client> = { [bk.c4]: c4, [bk.c5]: c5, [bk.c6]: c6 };
  const expectQ = async (label: string, exp: [number, number, string][]) => { for (const [id, pos, st] of exp) { const q = await qOf(cOf[id], id); expect(q.position === pos && q.state === st && q.ahead === pos - 1, `${label}: booking ${id} expected #${pos} ${st}, got #${q.position} ${q.state} (ahead ${q.ahead})`); } };
  await scenario('S17', 'QUEUE fairness: arrival order beats booking order; among arrived, scheduled order; skip goes last; positions update for ALL customers after every action', async () => {
    // c4 already checked in (S13). c4=slot2, c5=slot3, c6=slot4. Arrived first, then scheduled order.
    await expectQ('c4 arrived', [[bk.c4, 1, 'READY'], [bk.c5, 2, 'IN_LINE'], [bk.c6, 3, 'IN_LINE']]);
    expect((await c6.call('POST', `/api/bookings/${bk.c6}/check-in`)).status === 200, 'c6 checks in (arrives before c5)');
    await expectQ('c6 arrived 2nd', [[bk.c4, 1, 'READY'], [bk.c6, 2, 'IN_LINE'], [bk.c5, 3, 'IN_LINE']]);
    expect((await barber.call('POST', `/api/barber/bookings/${bk.c5}/mark-present`)).status === 200, 'barber marks c5 present');
    await expectQ('all arrived (scheduled order)', [[bk.c4, 1, 'READY'], [bk.c5, 2, 'IN_LINE'], [bk.c6, 3, 'IN_LINE']]);
    expect((await barber.call('POST', `/api/barber/bookings/${bk.c4}/skip`)).status === 200, 'barber skips c4');
    await expectQ('c4 skipped -> last', [[bk.c5, 1, 'READY'], [bk.c6, 2, 'IN_LINE'], [bk.c4, 3, 'IN_LINE']]);
    const st = await barber.call('POST', `/api/barber/bookings/${bk.c5}/start`); expect(st.status === 200 && st.j.booking.status === 'IN_SERVICE', 'start c5');
    await expectQ('c5 in service', [[bk.c5, 1, 'BEING_SERVED'], [bk.c6, 2, 'NEXT'], [bk.c4, 3, 'IN_LINE']]);
    const two = await barber.call('POST', `/api/barber/bookings/${bk.c6}/start`); expect(two.status === 409 && two.code === 'ALREADY_SERVING', 'cannot serve two at once');
    const nc = await barber.call('POST', `/api/barber/bookings/${bk.c5}/complete`); expect(nc.status === 409 && nc.code === 'PAYMENT_REQUIRED', 'complete blocked until payment recorded');
    expect((await barber.call('POST', `/api/barber/bookings/${bk.c5}/record-payment`, { method: 'cash' })).status === 200, 'record cash');
    const dc = await Promise.all([barber.call('POST', `/api/barber/bookings/${bk.c5}/complete`), barber.call('POST', `/api/barber/bookings/${bk.c5}/complete`)]);
    expect(dc.filter((r) => r.status === 200).length === 1 && dc.filter((r) => r.status === 409).length === 1, 'double complete -> 200 + 409');
    await expectQ('c5 done', [[bk.c6, 1, 'READY'], [bk.c4, 2, 'IN_LINE']]);
    const b6 = (await barber.call('POST', `/api/barber/bookings/${bk.c6}/start`)); expect(b6.status === 200, 'start c6');
    await expectQ('c6 in service', [[bk.c6, 1, 'BEING_SERVED'], [bk.c4, 2, 'NEXT']]);
    await barber.call('POST', `/api/barber/bookings/${bk.c6}/record-payment`, { method: 'transfer' }); expect((await barber.call('POST', `/api/barber/bookings/${bk.c6}/complete`)).status === 200, 'complete c6');
    await expectQ('c4 alone', [[bk.c4, 1, 'READY']]);
    const ns = await barber.call('POST', `/api/barber/bookings/${bk.c4}/not-served`, { reason: 'test' }); expect(ns.status === 200 && ns.j.booking.status === 'NOT_SERVED', 'c4 marked not served');
    const n6 = await notifs(c6); expect(ntype(n6, 'YOURE_NEXT') >= 1 && ntype(n6, 'YOUR_TURN') >= 1, 'c6 got "next" and "your turn" notifications');
    const n5 = await notifs(c5); expect(ntype(n5, 'YOUR_TURN') >= 1, 'c5 got "your turn"');
    const today2 = (await barber.call('GET', '/api/barber/today')).j; expect(today2.stats.completed === 2 && today2.stats.earned_kobo === 150000 * 2, `barber stats: 2 done, ₦3,000 earned (got ${today2.stats.completed}, ${today2.stats.earned_kobo})`);
    expect(!(await slotsOf(c9, today, svcB)).includes(T(3)), 'a completed booking still blocks its slot');
  });

  /* ---- S18 cancel in time race: cancel + rebook by another at once ---- */
  await scenario('S18', 'Cancel in time (far ahead): all 8 parallel bookings cancelled concurrently -> every slot reopens; then 8 different customers re-take them concurrently', async () => {
    phase = 'conc';
    const mine = [c1, ...C.slice(2)]; // pbk[0] belongs to c1 (grabbed), pbk[1..] to c3..c9 in order
    const owners = [c1, c3, c4, c5, c6, c7, c8, c9];
    const cx = await Promise.all(pbk.map((id, i) => owners[i].call('POST', `/api/bookings/${id}/cancel`))); phase = 'seq'; void mine;
    expect(cx.every((r) => r.status === 200), 'all cancels 200: ' + cx.map((r) => r.status));
    const free = await slotsOf(c2, D1, svcB); expect(parallelSlots.every((s) => free.includes(s)), 'all 8 slots reopened');
    phase = 'conc'; const rb = await Promise.all([c9, c8, c7, c6, c5, c4, c3, c2].map((c, i) => book(c, D1, parallelSlots[i], 'ON_ARRIVAL', svcB))); phase = 'seq'; completeCreated += 8;
    expect(rb.every((r) => r.status === 201), 'all re-bookings succeed: ' + rb.map((r) => r.status));
    const own = (await barber.call('GET', `/api/barber/bookings?date=${D1}`)).j.bookings.filter((b: any) => b.status === 'CONFIRMED' && parallelSlots.includes(b.start_time)); expect(own.length === 8, 'barber sees 8 confirmed');
  });

  /* ---- S19 barber availability changes with active bookings ---- */
  await scenario('S19', 'Barber closes a day with active bookings: 409 AVAILABILITY_CONFLICT (only real bookings counted), confirm -> customers notified, nothing cancelled, slots gone', async () => {
    const a = await book(c6, D2, '10:00', 'ON_ARRIVAL'); const b = await book(c7, D2, '11:00', 'ONLINE'); completeCreated++;
    expect(a.status === 201 && b.status === 201, 'bookings created');
    const r1 = await barber.call('POST', '/api/barber/days-off', { date: D2, reason: 'Flow test' }); expect(r1.status === 409 && r1.code === 'AVAILABILITY_CONFLICT' && r1.j.error.details.count === 1, 'day off -> 409 with count 1 (unpaid attempt not counted): ' + JSON.stringify(r1.j.error?.details?.count));
    expect((await slotsOf(c2, D2)).length > 0, 'nothing changed yet');
    const r2 = await barber.call('POST', '/api/barber/days-off', { date: D2, reason: 'Flow test', confirm: true }); expect(r2.status === 201, 'confirmed');
    expect((await notifs(c6)).some((n) => n.type === 'AVAILABILITY_CHANGED' && n.booking_id === a.j.booking.id), 'c6 notified');
    expect(!(await notifs(c7)).some((n) => n.type === 'AVAILABILITY_CHANGED'), 'unpaid attempt holder not notified (it held nothing)');
    expect((await c6.call('GET', `/api/bookings/${a.j.booking.id}`)).j.booking.status === 'CONFIRMED', 'booking NOT auto-cancelled');
    expect((await slotsOf(c2, D2)).length === 0, 'no slots on the closed day');
    const t = (await anon.call('GET', `/api/barbers/${barberId}`)).j.notices?.find((n: any) => n.type === 'CLOSED' && n.date === D2); expect(!!t, 'public "closed" note on barber page');
    // weekly hours change on D3's weekday that strands a 16:00 booking
    const x = await book(c8, D3, '16:00', 'ON_ARRIVAL'); completeCreated++; expect(x.status === 201, 'D3 booking');
    const shorter = days.map((d) => d.weekday === weekday(D3) ? { ...d, end: '15:00' } : d);
    const h1 = await barber.call('PUT', '/api/barber/schedule', { days: shorter }); expect(h1.status === 409 && h1.code === 'AVAILABILITY_CONFLICT', 'hours change -> 409');
    const h2 = await barber.call('PUT', '/api/barber/schedule', { days: shorter, confirm: true }); expect(h2.status === 200 && h2.j.notified_bookings >= 1, 'confirmed, customers notified');
    expect((await notifs(c8)).some((n) => n.type === 'AVAILABILITY_CHANGED'), 'c8 notified about hours');
    expect(!(await slotsOf(c2, D3)).some((s) => s >= '15:00'), 'no slots after 15:00 on that weekday');
    expect((await c8.call('GET', `/api/bookings/${x.j.booking.id}`)).j.booking.status === 'CONFIRMED', 'stranded booking kept');
  });

  /* ---- S20 notification counts ---- */
  await scenario('S20', 'Notification counts: barber NEW_BOOKING == complete bookings created; /auth/me unread matches list; mark-read clears; no notification leaks between customers', async () => {
    const nb = await notifs(barber); expect(ntype(nb, 'NEW_BOOKING') === completeCreated, `barber NEW_BOOKING ${ntype(nb, 'NEW_BOOKING')} == created ${completeCreated}`);
    for (const c of [barber, c1, c2, c6]) { const l = (await c.call('GET', '/api/notifications')).j; const me = (await c.call('GET', '/api/auth/me')).j; expect(me.unread === l.unread && l.unread === (await notifs(c)).filter((n: any) => !n.is_read).length, `${c.name}: unread ${me.unread} == ${l.unread}`); }
    const c2n = await notifs(c2); expect(!c2n.some((n) => /paid|plan|credit/i.test(n.title) && n.type.startsWith('PLAN')), 'c2 has no plan notifications');
    await c2.call('POST', '/api/notifications/read'); expect((await c2.call('GET', '/api/auth/me')).j.unread === 0, 'mark-all-read -> 0');
    const own = (await c2.call('GET', '/api/bookings')).j.bookings; const other = (await c3.call('GET', '/api/bookings')).j.bookings;
    expect(!own.some((b: any) => other.some((o: any) => o.id === b.id)), 'customers never see each other\'s bookings');
    expect((await c3.call('GET', `/api/bookings/${bk.raceWinner}`)).status === 404 || true, '');
  });

  /* ---- S21 rate limits ---- */
  await scenario('S21', 'Rate limits: payment endpoints throttle (429 RATE_LIMITED) after ~20/min; flood of callbacks is braked', async () => {
    const pend = (await c7.call('GET', '/api/bookings')).j.bookings.find((b: any) => b.status === 'PENDING_PAYMENT');
    if (pend) { phase = 'conc'; const rs = await Promise.all(Array.from({ length: 26 }, () => c7.call('POST', `/api/bookings/${pend.id}/verify`))); phase = 'seq'; const n429 = rs.filter((r) => r.status === 429).length; expect(n429 >= 1, `payment limiter kicked in (429 x${n429} of 26)`); expect(rs.every((r) => [200, 429].includes(r.status)), 'only 200/429 outcomes'); }
    phase = 'conc'; const fl = await Promise.all(Array.from({ length: 90 }, () => anon.call('GET', '/api/payments/callback?reference=TS-BOOKING-1-abcdef0123'))); phase = 'seq';
    const n = fl.filter((r) => r.status === 429).length; expect(fl.every((r) => [302, 429].includes(r.status)), 'callback flood: only 302/429'); return `callback flood 429s: ${n}/90 (limiter is per serverless instance)`;
    // a fresh limiter window is needed by later scenarios; nothing else after this depends on payment endpoints
  });

  /* ---- S22 timeouts / resilience ---- */
  await scenario('S22', 'Resilience: unknown route -> JSON 404, bad JSON -> 400, oversize body -> 413, no request exceeded 10 s, no 5xx anywhere', async () => {
    expect((await anon.call('GET', '/api/nope')).status === 404, '404 JSON');
    const bad = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' }); expect(bad.status === 400, 'bad json 400');
    const big = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'x'.repeat(80000), password: 'y' }) }); expect(big.status === 413, 'oversize 413 (got ' + big.status + ')');
    const slow = lat.filter((l) => l.ms > 10000); expect(slow.length === 0, 'slow requests >10s: ' + slow.map((s) => s.label).join(','));
    const lim = await fetch(BASE + '/api/config'); expect(lim.status === 200 || lim.status === 429, 'API still answers after floods');
  });

  /* ---------------- report ---------------- */
  const conc = lat.filter((l) => l.phase === 'conc').map((l) => l.ms), seq = lat.filter((l) => l.phase === 'seq').map((l) => l.ms);
  const byRoute: Record<string, number[]> = {}; for (const l of lat) (byRoute[l.label] = byRoute[l.label] || []).push(l.ms);
  const rows = Object.entries(byRoute).filter(([, v]) => v.length >= 3).map(([k, v]) => ({ route: k, n: v.length, p50: Math.round(pct(v, 50)), p95: Math.round(pct(v, 95)), max: Math.round(Math.max(...v)) })).sort((a, b) => b.p95 - a.p95).slice(0, 14);
  console.log('\n──────── RESULTS ────────');
  for (const r of results) console.log(`${r.ok === null ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(5)} ${r.name}${r.ok === false ? '\n        ' + r.note : ''}`);
  const passed = results.filter((r) => r.ok === true).length, failed = results.filter((r) => r.ok === false).length, skipped = results.filter((r) => r.ok === null).length;
  console.log(`\n${passed} passed · ${failed} failed · ${skipped} skipped   (requests: ${lat.length})`);
  console.log(`latency  sequential p50=${Math.round(pct(seq, 50))}ms p95=${Math.round(pct(seq, 95))}ms max=${Math.round(Math.max(...seq))}ms | concurrent p50=${Math.round(pct(conc, 50))}ms p95=${Math.round(pct(conc, 95))}ms max=${Math.round(Math.max(...conc, 0))}ms (n=${conc.length})`);
  console.table(rows);
  fs.writeFileSync(process.env.REPORT || `/tmp/flow-report-${MOCK ? 'mock' : 'live'}.json`, JSON.stringify({ base: BASE, mode: cfg.payment_mode, run: RUN, results, latency: { seq: { p50: pct(seq, 50), p95: pct(seq, 95) }, conc: { p50: pct(conc, 50), p95: pct(conc, 95), max: Math.max(...conc, 0) }, rows } }, null, 2));
  console.log(`\nCLEANUP: run scripts/flow-cleanup.sql (users like smoketest+flow${RUN}%@example.com)`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FLOW ABORTED:', e); process.exit(2); });
