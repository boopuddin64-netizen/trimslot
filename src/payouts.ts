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

export async function listBanks(): Promise<Bank[]> {
  if (hooks.banks) return hooks.banks();
  if (config.mockMode) return MOCK_BANKS;
  if (bankCache && Date.now() - bankCache.at < 6 * 3600_000) return bankCache.banks;
  const j = await paystackFetch('/bank?country=nigeria&currency=NGN&perPage=200&use_cursor=false');
  const banks = (j.data as any[]).filter((b) => b && b.code && b.name && b.active !== false && !b.is_deleted)
    .map((b) => ({ name: String(b.name), code: String(b.code) })).sort((a, b) => a.name.localeCompare(b.name));
  const seen = new Set<string>(); const uniq = banks.filter((b) => (seen.has(b.code) ? false : (seen.add(b.code), true)));
  bankCache = { at: Date.now(), banks: uniq };
  return uniq;
}

export const acctSchema = z.object({ bank_code: z.string().trim().regex(/^[0-9]{2,8}$/, 'Choose your bank'), account_number: z.string().trim().regex(/^[0-9]{10}$/, 'Account number is 10 digits') });

export async function resolveAccount(bank: string, acct: string): Promise<string> {
  if (hooks.resolve) return hooks.resolve(bank, acct);
  if (config.mockMode) return acct.endsWith('0000') ? (() => { throw badRequest('We could not find that account. Check the number and bank.'); })() : 'MOCK ACCOUNT ' + acct.slice(-4);
  try {
    const j = await paystackFetch(`/bank/resolve?account_number=${acct}&bank_code=${bank}`);
    const name = String(j.data?.account_name || '').trim();
    if (!name) throw badRequest('We could not find that account. Check the number and bank.');
    return name;
  } catch (e: any) {
    if (e instanceof AppError && e.status === 400) throw e;
    const m = String(e?.message || '');
    if (/could not resolve|invalid|not found|match/i.test(m)) throw badRequest('We could not find that account. Check the number and bank.');
    throw new AppError(502, 'RESOLVE_UNAVAILABLE', config.paystackMode === 'LIVE' ? 'Account lookup is unavailable right now. Please try again in a minute.' : 'Account lookup is not available in Paystack test mode for this bank. In test mode you can continue with the name you type.');
  }
}

async function createSubaccount(o: { name: string; bank: string; acct: string }): Promise<string> {
  if (hooks.subaccount) return hooks.subaccount(o);
  if (config.mockMode) return 'ACCT_MOCK' + crypto.randomBytes(5).toString('hex');
  // percentage_charge 0: the platform fee is passed per transaction (transaction_charge), so the split is fully controlled by the app.
  const j = await paystackFetch('/subaccount', { method: 'POST', body: JSON.stringify({ business_name: o.name.slice(0, 80), settlement_bank: o.bank, account_number: o.acct, percentage_charge: 0, description: 'TrimSlot barber payout' }) });
  const code = String(j.data?.subaccount_code || '');
  if (!/^ACCT_[A-Za-z0-9]+$/.test(code)) throw new AppError(502, 'PAYSTACK_ERROR', 'Paystack did not return a payout account. Try again.');
  return code;
}

export interface PayoutStatus { status: 'ACTIVE' | 'NONE'; bank_name: string | null; account_last4: string | null; account_name: string | null; set_at: string | null; test_mode: boolean; required: boolean }
export async function payoutStatus(db: Db, barberId: number): Promise<PayoutStatus> {
  const b = await db.one<any>('SELECT paystack_subaccount, payout_bank_name, payout_account_last4, payout_account_name, payout_set_at FROM barbers WHERE id=$1', [barberId]);
  return { status: b.paystack_subaccount ? 'ACTIVE' : 'NONE', bank_name: b.payout_bank_name, account_last4: b.payout_account_last4, account_name: b.payout_account_name, set_at: b.payout_set_at, test_mode: config.paystackMode !== 'LIVE', required: config.requirePayout };
}

/** Resolve + create/replace the barber's subaccount. The account holder name comes from the bank lookup, not from the client (except test mode when lookup is unavailable). */
export async function savePayout(db: Db, userId: number, barberId: number, input: unknown) {
  const d = acctSchema.extend({ account_name: z.string().trim().min(2).max(80).optional() }).safeParse(input);
  if (!d.success) throw badRequest(d.error.issues[0]?.message || 'Check the bank details');
  const banks = await listBanks();
  const bank = banks.find((b) => b.code === d.data.bank_code); if (!bank) throw badRequest('Choose your bank from the list');
  let name: string;
  try { name = await resolveAccount(bank.code, d.data.account_number); }
  catch (e: any) { if (e instanceof AppError && e.code === 'RESOLVE_UNAVAILABLE' && config.paystackMode !== 'LIVE' && d.data.account_name) name = d.data.account_name; else throw e; }
  const shop = await db.one<{ shop_name: string }>('SELECT shop_name FROM barbers WHERE id=$1', [barberId]);
  const code = await createSubaccount({ name: shop.shop_name + ' / ' + name, bank: bank.code, acct: d.data.account_number });
  await db.tx(async (t) => {
    await t.query(`UPDATE barbers SET paystack_subaccount=$2, payout_bank_code=$3, payout_bank_name=$4, payout_account_last4=$5, payout_account_name=$6, payout_set_at=$7 WHERE id=$1`,
      [barberId, code, bank.code, bank.name, d.data.account_number.slice(-4), name, isoNow()]);
    await audit(t, null, { id: userId, role: 'barber' }, 'BARBER_PAYOUT_SET', { barber_id: barberId, bank: bank.name, last4: d.data.account_number.slice(-4) });
  });
  return payoutStatus(db, barberId);
}
