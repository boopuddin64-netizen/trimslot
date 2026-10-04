/** Barber payout setup: bank list, account-name resolve, Paystack subaccount creation. The full account number is NEVER stored (only the last 4 digits). */
import { z } from 'zod';
import { Db } from './db';
import { config } from './config';
import { AppError, badRequest } from './errors';
import { paystackFetch } from './paystack';
import { isoNow } from './time';
import { audit } from './helpers';
import crypto from 'crypto';

export interface Bank { name: string; code: string }
const MOCK_BANKS: Bank[] = [{ name: 'Access Bank', code: '044' }, { name: 'First Bank of Nigeria', code: '011' }, { name: 'Guaranty Trust Bank', code: '058' }, { name: 'Kuda Microfinance Bank', code: '50211' }, { name: 'Opay', code: '999992' }, { name: 'United Bank for Africa', code: '033' }, { name: 'Zenith Bank', code: '057' }];
let bankCache: { at: number; banks: Bank[] } | null = null;
let hooks: { banks?: () => Promise<Bank[]>; resolve?: (bank: string, acct: string) => Promise<string>; subaccount?: (o: { name: string; bank: string; acct: string }) => Promise<string> } = {};
/** Test hook. */
export function setPayoutGateway(h: typeof hooks) { hooks = h; bankCache = null; }

const FALLBACK_BANKS: Bank[] = [['Access Bank', '044'], ['Ecobank Nigeria', '050'], ['Fidelity Bank', '070'], ['First Bank of Nigeria', '011'], ['First City Monument Bank', '214'], ['Guaranty Trust Bank', '058'], ['Heritage Bank', '030'], ['Keystone Bank', '082'], ['Kuda Microfinance Bank', '50211'], ['Moniepoint MFB', '50515'], ['Opay', '999992'], ['PalmPay', '999991'], ['Polaris Bank', '076'], ['Stanbic IBTC Bank', '221'], ['Sterling Bank', '232'], ['Union Bank of Nigeria', '032'], ['United Bank for Africa', '033'], ['Wema Bank', '035'], ['Zenith Bank', '057']].map(([name, code]) => ({ name, code }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Call Paystack, retrying ONCE when the failure is transient (timeout, 5xx, 429). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) { if (e instanceof AppError && (e.details as any)?.transient) { await sleep(500); return fn(); } throw e; }
}
export interface BankList { banks: Bank[]; source: 'live' | 'cache' | 'stale' | 'fallback' }
/** Bank list: cached 6 h per instance; on a Paystack failure serve the stale cache, then a built-in list of the common banks - never an empty picker. */
export async function listBankInfo(): Promise<BankList> {
  if (hooks.banks) return { banks: await hooks.banks(), source: 'live' };
  if (config.mockMode) return { banks: MOCK_BANKS, source: 'live' };
  if (bankCache && Date.now() - bankCache.at < 6 * 3600_000) return { banks: bankCache.banks, source: 'cache' };
  try {
    const j = await withRetry(() => paystackFetch('/bank?country=nigeria&currency=NGN&perPage=200&use_cursor=false'));
    const banks = (j.data as any[]).filter((b) => b && b.code && b.name && b.active !== false && !b.is_deleted)
      .map((b) => ({ name: String(b.name), code: String(b.code) })).sort((a, b) => a.name.localeCompare(b.name));
    const seen = new Set<string>(); const uniq = banks.filter((b) => (seen.has(b.code) ? false : (seen.add(b.code), true)));
    if (uniq.length < 5) throw new AppError(502, 'PAYSTACK_ERROR', 'We could not load the bank list. Try again.');
    bankCache = { at: Date.now(), banks: uniq };
    return { banks: uniq, source: 'live' };
  } catch (e) {
    if (bankCache) return { banks: bankCache.banks, source: 'stale' };
    return { banks: FALLBACK_BANKS, source: 'fallback' };
  }
}
export async function listBanks(): Promise<Bank[]> { return (await listBankInfo()).banks; }

export const acctSchema = z.object({ bank_code: z.string().trim().regex(/^[0-9]{2,8}$/, 'Choose your bank.'), account_number: z.string().trim().regex(/^[0-9]{10}$/, 'The account number has 10 digits.') });

const NOT_FOUND_RE = /could not resolve|cannot resolve|unable to resolve|invalid (account|nuban)|account number is invalid|not found|does not match|no account/i;
const LIMIT_RE = /limit|exceed|too many|rate|quota/i;
/** Look up the account holder's name. 400 ACCOUNT_NOT_FOUND = wrong number/bank. 502 RESOLVE_UNAVAILABLE = the lookup itself is unavailable (details.reason: 'limit' | 'unreachable' | 'unavailable'). One automatic retry on transient failures. */
export async function resolveAccount(bank: string, acct: string): Promise<string> {
  if (hooks.resolve) return hooks.resolve(bank, acct);
  if (config.mockMode) {   // deterministic mock: ...0000 = unknown account, ...9999 = lookup unavailable (exercises the typed-name fallback)
    if (acct.endsWith('0000')) throw new AppError(400, 'ACCOUNT_NOT_FOUND', "We could not find that account. Check the number and the bank.");
    if (acct.endsWith('9999')) throw new AppError(502, 'RESOLVE_UNAVAILABLE', "We cannot look up the account name right now. Paystack test mode allows only a few lookups a day. Type the account name exactly as it is on the account.", { reason: 'unavailable', test_mode: true });
    return 'MOCK ACCOUNT ' + acct.slice(-4);
  }
  try {
    const j = await withRetry(() => paystackFetch(`/bank/resolve?account_number=${encodeURIComponent(acct)}&bank_code=${encodeURIComponent(bank)}`));
    const name = String(j.data?.account_name || '').trim();
    if (!name) throw new AppError(400, 'ACCOUNT_NOT_FOUND', "We could not find that account. Check the number and the bank.");
    return name;
  } catch (e: any) {
    if (!(e instanceof AppError)) throw e;
    if (e.code === 'ACCOUNT_NOT_FOUND') throw e;
    const d: any = e.details || {}; const m = String(d.gateway_message || e.message || '');
    if (d.gateway_status === 422 || d.gateway_status === 404 || (NOT_FOUND_RE.test(m) && !LIMIT_RE.test(m))) throw new AppError(400, 'ACCOUNT_NOT_FOUND', "We could not find that account. Check the number and the bank.");
    const reason = e.code === 'PAYSTACK_UNREACHABLE' ? 'unreachable' : LIMIT_RE.test(m) ? 'limit' : 'unavailable';
    const test = config.paystackMode !== 'LIVE';
    const msg = reason === 'unreachable' ? "We could not reach the bank. Try again, or type the account name yourself."
      : reason === 'limit' || test ? "We cannot look up the account name right now" + (test ? ' (Paystack test mode allows only a few lookups a day)' : '') + '. Type the account name exactly as it is on the account.'
      : "We cannot look up the account name right now. Try again in a minute, or type the account name exactly as it is on the account.";
    throw new AppError(502, 'RESOLVE_UNAVAILABLE', msg, { reason, test_mode: test, gateway_message: m.slice(0, 160) });
  }
}

async function createSubaccount(o: { name: string; bank: string; acct: string }): Promise<string> {
  if (hooks.subaccount) return hooks.subaccount(o);
  if (config.mockMode) return 'ACCT_MOCK' + crypto.randomBytes(5).toString('hex');
  // percentage_charge 0: the platform fee is passed per transaction (transaction_charge), so the split is fully controlled by the app.
  const j = await withRetry(() => paystackFetch('/subaccount', { method: 'POST', body: JSON.stringify({ business_name: o.name.slice(0, 80), settlement_bank: o.bank, account_number: o.acct, percentage_charge: 0, description: 'TrimSlot barber payout' }) })).catch((e: any) => {
    const m = String(e?.details?.gateway_message || e?.message || '');
    if (e instanceof AppError && /account|bank|invalid|resolve/i.test(m) && !(e.details as any)?.transient) throw new AppError(400, 'ACCOUNT_REJECTED', "Paystack could not check that bank account. Check the account number and the bank, then try again.", { gateway_message: m.slice(0, 160) });
    throw e;
  });
  const code = String(j.data?.subaccount_code || '');
  if (!/^ACCT_[A-Za-z0-9]+$/.test(code)) throw new AppError(502, 'PAYSTACK_ERROR', 'Paystack did not set up your payout account. Try again.');
  return code;
}

export interface PayoutStatus { status: 'ACTIVE' | 'NONE'; bank_name: string | null; account_last4: string | null; account_name: string | null; name_verified: boolean; set_at: string | null; test_mode: boolean; required: boolean }
export async function payoutStatus(db: Db, barberId: number): Promise<PayoutStatus> {
  const b = await db.one<any>('SELECT paystack_subaccount, payout_bank_name, payout_account_last4, payout_account_name, payout_name_verified, payout_set_at FROM barbers WHERE id=$1', [barberId]);
  return { status: b.paystack_subaccount ? 'ACTIVE' : 'NONE', bank_name: b.payout_bank_name, account_last4: b.payout_account_last4, account_name: b.payout_account_name, name_verified: b.payout_name_verified !== false, set_at: b.payout_set_at, test_mode: config.paystackMode !== 'LIVE', required: config.requirePayout };
}

/** Resolve + create/replace the barber's subaccount. The account holder name comes from the bank lookup, not from the client (except test mode when lookup is unavailable). */
export async function savePayout(db: Db, userId: number, barberId: number, input: unknown) {
  const d = acctSchema.extend({ account_name: z.string().trim().min(2).max(80).optional() }).safeParse(input);
  if (!d.success) throw badRequest(d.error.issues[0]?.message || 'Check your bank details.');
  const banks = await listBanks();
  const bank = banks.find((b) => b.code === d.data.bank_code); if (!bank) throw badRequest('Choose your bank from the list.');
  let name: string, verified = true;
  try { name = await resolveAccount(bank.code, d.data.account_number); }
  catch (e: any) {
    // lookup unavailable (Paystack test-mode limits, outage): continue with the name the barber typed, flagged "not verified".
    // The subaccount call below still makes Paystack validate the bank + account number.
    if (e instanceof AppError && e.code === 'RESOLVE_UNAVAILABLE' && d.data.account_name) { name = d.data.account_name; verified = false; } else throw e;
  }
  const shop = await db.one<{ shop_name: string }>('SELECT shop_name FROM barbers WHERE id=$1', [barberId]);
  const code = await createSubaccount({ name: shop.shop_name + ' / ' + name, bank: bank.code, acct: d.data.account_number });
  await db.tx(async (t) => {
    await t.query(`UPDATE barbers SET paystack_subaccount=$2, payout_bank_code=$3, payout_bank_name=$4, payout_account_last4=$5, payout_account_name=$6, payout_set_at=$7, payout_name_verified=$8 WHERE id=$1`,
      [barberId, code, bank.code, bank.name, d.data.account_number.slice(-4), name, isoNow(), verified]);
    await audit(t, null, { id: userId, role: 'barber' }, 'BARBER_PAYOUT_SET', { barber_id: barberId, bank: bank.name, last4: d.data.account_number.slice(-4), name_verified: verified });
  });
  return payoutStatus(db, barberId);
}
