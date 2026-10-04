import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers';
import { listBankInfo, resolveAccount, savePayout, payoutStatus, setPayoutGateway } from '../src/payouts';
import { AppError } from '../src/errors';

/** Run `fn` against the REAL Paystack client code with a scripted fetch (test-mode key, no network). */
async function withFetch<T>(script: Array<{ status?: number; body?: any; throws?: string }>, fn: (calls: string[]) => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch, prevKey = process.env.PAYSTACK_SECRET_KEY;
  const calls: string[] = []; let i = 0;
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_unit'; setPayoutGateway({});
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push(`${init?.method || 'GET'} ${String(url).replace('https://api.paystack.co', '')}`);
    const step = script[Math.min(i++, script.length - 1)];
    if (step.throws) { const e: any = new Error(step.throws); e.name = step.throws; throw e; }
    return new Response(JSON.stringify(step.body ?? {}), { status: step.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  try { return await fn(calls); }
  finally { globalThis.fetch = realFetch; if (prevKey === undefined) delete process.env.PAYSTACK_SECRET_KEY; else process.env.PAYSTACK_SECRET_KEY = prevKey; setPayoutGateway({}); }
}
const OK_NAME = { status: 200, body: { status: true, data: { account_name: 'ADA OBI' } } };
const expectErr = async (p: Promise<unknown>, status: number, code: string) => {
  await assert.rejects(p, (e: any) => { assert.ok(e instanceof AppError, 'AppError expected, got ' + e); assert.equal(e.status, status); assert.equal(e.code, code); return true; });
};

test('resolve: a transient 502 is retried once and then succeeds', async () => {
  await withFetch([{ status: 502, body: { status: false, message: 'Bad gateway' } }, OK_NAME], async (calls) => {
    assert.equal(await resolveAccount('058', '0123456789'), 'ADA OBI'); assert.equal(calls.length, 2);
  });
});
test('resolve: a timeout/network failure is retried once, and a second failure is RESOLVE_UNAVAILABLE (reason unreachable)', async () => {
  await withFetch([{ throws: 'TimeoutError' }, OK_NAME], async (c) => { assert.equal(await resolveAccount('058', '0123456789'), 'ADA OBI'); assert.equal(c.length, 2); });
  await withFetch([{ throws: 'TimeoutError' }], async (c) => {
    await assert.rejects(resolveAccount('058', '0123456789'), (e: any) => { assert.equal(e.code, 'RESOLVE_UNAVAILABLE'); assert.equal(e.status, 502); assert.equal(e.details.reason, 'unreachable'); return true; });
    assert.equal(c.length, 2, 'exactly one retry');
  });
});
test('resolve: wrong account => 400 ACCOUNT_NOT_FOUND with no retry; 422 too', async () => {
  await withFetch([{ status: 422, body: { status: false, message: 'Could not resolve account name. Check parameters or try again.' } }], async (c) => {
    await expectErr(resolveAccount('058', '0123456789'), 400, 'ACCOUNT_NOT_FOUND'); assert.equal(c.length, 1);
  });
});
test('resolve: test-mode lookup limit / outage => RESOLVE_UNAVAILABLE with a clear message and the gateway reason (no raw "Paystack error")', async () => {
  await withFetch([{ status: 400, body: { status: false, message: 'You have exceeded the daily limit for test account lookups' } }], async () => {
    await assert.rejects(resolveAccount('058', '0123456789'), (e: any) => { assert.equal(e.code, 'RESOLVE_UNAVAILABLE'); assert.equal(e.details.reason, 'limit'); assert.match(e.message, /type the account name/i); assert.doesNotMatch(e.message, /Paystack error/); return true; });
  });
  await withFetch([{ status: 503, body: { status: false, message: 'Service unavailable' } }], async (c) => {
    await assert.rejects(resolveAccount('058', '0123456789'), (e: any) => { assert.equal(e.code, 'RESOLVE_UNAVAILABLE'); assert.equal(e.details.reason, 'unavailable'); return true; }); assert.equal(c.length, 2);
  });
});

test('bank list: loads from Paystack, caches (second call = no fetch), de-dupes, survives an outage with the stale cache, and never returns an empty list', async () => {
  const banks = { status: true, data: [{ name: 'Zenith Bank', code: '057', active: true }, { name: 'Access Bank', code: '044', active: true }, { name: 'GTBank', code: '058', active: true }, { name: 'UBA', code: '033', active: true }, { name: 'Wema', code: '035', active: true }, { name: 'Dup', code: '035', active: true }, { name: 'Old', code: '999', active: false }] };
  await withFetch([{ body: banks }, { status: 500, body: { status: false, message: 'boom' } }], async (calls) => {
    const a = await listBankInfo(); assert.equal(a.source, 'live'); assert.deepEqual(a.banks.map((b) => b.code), ['044', '058', '033', '035', '057'].sort((x, y) => a.banks.findIndex((b) => b.code === x) - a.banks.findIndex((b) => b.code === y)));
    assert.equal(a.banks.length, 5, 'inactive + duplicate removed'); assert.equal(a.banks[0].name, 'Access Bank', 'sorted by name');
    const b = await listBankInfo(); assert.equal(b.source, 'cache'); assert.equal(calls.length, 1, 'cached: no second request');
  });
  // fresh cache (setPayoutGateway resets it) + Paystack down => built-in list of common banks, not an empty picker
  await withFetch([{ status: 500, body: { status: false, message: 'down' } }], async (calls) => {
    const f = await listBankInfo(); assert.equal(f.source, 'fallback'); assert.ok(f.banks.length >= 15); assert.ok(f.banks.some((x) => x.code === '058')); assert.equal(calls.length, 2, 'one retry');
  });
});

test('payout setup with a typed name: lookup unavailable => needs the name; with the name it creates the subaccount and flags the name unverified', async () => {
  const { db, barberId } = await freshDb();
  const uid = (await db.one<any>('SELECT user_id FROM barbers WHERE id=$1', [barberId])).user_id;
  const script = (acctOk: boolean) => [
    { status: 200, body: { status: true, data: [{ name: 'Zenith Bank', code: '057', active: true }, { name: 'Access Bank', code: '044', active: true }, { name: 'GTBank', code: '058', active: true }, { name: 'UBA', code: '033', active: true }, { name: 'Wema', code: '035', active: true }] } },
    { status: 400, body: { status: false, message: 'Test mode: lookup limit reached' } },      // resolve (limit => no retry, 400 isn't transient)
    acctOk ? { status: 200, body: { status: true, data: { subaccount_code: 'ACCT_typed123' } } } : { status: 400, body: { status: false, message: 'Account number is invalid' } },
  ];
  await withFetch(script(true), async (calls) => {
    await expectErr(savePayout(db, uid, barberId, { bank_code: '057', account_number: '0000000000' }), 502, 'RESOLVE_UNAVAILABLE');
    assert.equal((await payoutStatus(db, barberId)).status, 'NONE');
  });
  await withFetch([script(true)[0], script(true)[1], script(true)[2]], async (calls) => {
    const r: any = await savePayout(db, uid, barberId, { bank_code: '057', account_number: '0000000000', account_name: 'Ada Obi' });
    const st = await payoutStatus(db, barberId);
    assert.equal(st.status, 'ACTIVE'); assert.equal(st.account_name, 'Ada Obi'); assert.equal(st.name_verified, false); assert.equal(st.account_last4, '0000');
    const sub = calls.find((c) => c.includes('/subaccount')); assert.ok(sub, 'subaccount created');
    assert.ok(r);
  });
});
test('payout setup: Paystack rejecting the account at subaccount creation => clear 400 ACCOUNT_REJECTED, nothing saved', async () => {
  const { db, barberId } = await freshDb();
  const uid = (await db.one<any>('SELECT user_id FROM barbers WHERE id=$1', [barberId])).user_id;
  const banks = { status: 200, body: { status: true, data: [{ name: 'Zenith Bank', code: '057', active: true }, { name: 'Access Bank', code: '044', active: true }, { name: 'GTBank', code: '058', active: true }, { name: 'UBA', code: '033', active: true }, { name: 'Wema', code: '035', active: true }] } };
  await withFetch([banks, OK_NAME, { status: 400, body: { status: false, message: 'Account number is invalid' } }], async () => {
    await expectErr(savePayout(db, uid, barberId, { bank_code: '057', account_number: '0123456789' }), 400, 'ACCOUNT_REJECTED');
  });
  assert.equal((await payoutStatus(db, barberId)).status, 'NONE');
});
