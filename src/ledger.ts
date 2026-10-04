/**
 * Off-app commission ledger + the pay-now split.
 *  - Pay-now (Paystack): the customer pays price + booking fee. Paystack sends the barber `price - barber's fee share - platform charge`; the platform account keeps the rest (see fees.ts).
 *  - Off-app (pay on arrival / cash / transfer) completed bookings accrue a DEBT = commission_factor x the platform charge (the platform charge alone).
 *  - That debt is netted against the barber's next in-app transactions by raising `transaction_charge` (never more than the debt, never below the barber's minimum payout share),
 *    recorded on the payment (debt_netted_kobo) and only applied to the ledger once the payment is CONFIRMED. Refunds reverse it. Everything is idempotent.
 */
import { Conn } from './db';
import { ChargeOverride, FeeBreakdown, feeSettingsOf, offAppBreakdown, onlineBreakdown, platformChargeKobo } from './fees';
import { AppError } from './errors';
import { audit, naira, notify } from './helpers';
import { getSettings, Settings } from './plans';
import { clock, isoNow } from './time';

export type FeeOverride = ChargeOverride;

/** Commission owed for an off-app booking: commission_factor x the platform charge (the platform charge alone - no Paystack part). */
export function commissionKobo(priceKobo: number, s: Pick<Settings, 'charge_percent' | 'charge_flat_kobo' | 'charge_min_kobo' | 'commission_factor'>, barber?: FeeOverride | null): number {
  return Math.max(0, Math.round(platformChargeKobo(priceKobo, s, barber) * Number(s.commission_factor)));
}

/** How much outstanding debt can ride on ONE in-app transaction. Pure function (unit-tested). */
export function nettableKobo(o: { amountKobo: number; feeKobo: number; outstandingKobo: number; minPayoutPercent: number }): number {
  const minPayout = Math.ceil((o.amountKobo * o.minPayoutPercent) / 100);
  const room = Math.max(0, o.amountKobo - o.feeKobo - minPayout);       // barber keeps at least minPayout
  return Math.max(0, Math.min(o.outstandingKobo, room));
}

export async function outstandingKobo(c: Conn, barberId: number): Promise<number> {
  return Number((await c.one<any>(`SELECT COALESCE(SUM(remaining_kobo),0)::bigint AS s FROM commission_ledger WHERE barber_id=$1 AND status='ACCRUED'`, [barberId])).s);
}
/** Debt already earmarked by other unpaid checkouts (so two open checkouts never net the same debt twice). */
async function reservedKobo(c: Conn, barberId: number): Promise<number> {
  return Number((await c.one<any>(`SELECT COALESCE(SUM(debt_netted_kobo),0)::bigint AS s FROM payments WHERE barber_id=$1 AND status='INITIATED' AND debt_netted_kobo>0 AND created_at > ($2::timestamptz - interval '60 minutes')`, [barberId, isoNow()])).s);
}

/** The pay-now money breakdown for a price (same numbers the customer is shown), plus the debt that can ride on this payment and what the platform account must keep in the Paystack split. */
export async function previewBreakdown(c: Conn, barber: ChargeOverride | null, priceKobo: number): Promise<FeeBreakdown> {
  return onlineBreakdown(priceKobo, feeSettingsOf(await getSettings(c)), barber);
}
export async function planCheckoutSplit(c: Conn, barber: { id: number; paystack_subaccount: string | null } & FeeOverride, bd: FeeBreakdown) {
  const s = await getSettings(c);
  let netted = 0;
  if (barber.paystack_subaccount && s.commission_enabled) {
    const open = Math.max(0, (await outstandingKobo(c, barber.id)) - (await reservedKobo(c, barber.id)));
    netted = nettableKobo({ amountKobo: bd.price_kobo, feeKobo: bd.barber_fee_kobo + bd.platform_charge_kobo, outstandingKobo: open, minPayoutPercent: s.min_barber_payout_percent });
  }
  // Paystack sends (amount - transaction_charge) to the barber, so the charge is everything that is NOT the barber's payout.
  const charge = bd.total_kobo - bd.payout_kobo + netted;
  return { fee: bd.platform_charge_kobo, netted, charge };
}

/** Accrue the commission for a COMPLETED off-app booking. Idempotent (unique per booking). Returns the new ledger id or null. */
export async function accrueCommission(t: Conn, b: { id: number; barber_id: number; price_kobo: number; platform_charge_kobo?: number; payment_option: string; payment_status: string; paid_via: string | null; service_name: string }): Promise<number | null> {
  if (b.payment_option !== 'ON_ARRIVAL' || b.payment_status !== 'PAID') return null;       // in-app, plan and credit bookings already paid their fee at purchase
  const s = await getSettings(t);
  if (!s.commission_enabled) return null;
  const barber = await t.one<any>('SELECT fee_percent_override, fee_flat_kobo_override FROM barbers WHERE id=$1', [b.barber_id]);
  const amount = (b.platform_charge_kobo ?? 0) > 0 ? Math.max(0, Math.round(b.platform_charge_kobo! * Number(s.commission_factor))) : commissionKobo(b.price_kobo, s, barber);
  if (amount <= 0) return null;
  const r = await t.maybeOne<{ id: number }>(`INSERT INTO commission_ledger (barber_id, booking_id, kind, amount_kobo, remaining_kobo, note, created_at)
      VALUES ($1,$2,'COMMISSION',$3,$3,$4,$5) ON CONFLICT (booking_id) WHERE booking_id IS NOT NULL DO NOTHING RETURNING id`,
    [b.barber_id, b.id, amount, `${b.service_name} (${naira(b.price_kobo)} paid ${(b.paid_via || 'off-app').toLowerCase()})`, isoNow()]);
  if (!r) return null;
  await audit(t, b.id, { id: null, role: 'system' }, 'COMMISSION_ACCRUED', { ledger_id: r.id, amount_kobo: amount, price_kobo: b.price_kobo });
  return r.id;
}

type Kind = 'NETTED' | 'MANUAL_SETTLE' | 'WAIVE';
/** FIFO: take up to `amount` off the oldest open entries. Returns how much was actually applied. */
async function applyFifo(t: Conn, barberId: number, amount: number, kind: Kind, o: { paymentId?: number | null; reason?: string | null }): Promise<number> {
  let left = amount; const now = isoNow();
  const rows = await t.many<any>(`SELECT id, remaining_kobo FROM commission_ledger WHERE barber_id=$1 AND status='ACCRUED' ORDER BY id FOR UPDATE`, [barberId]);
  for (const r of rows) {
    if (left <= 0) break;
    const take = Math.min(left, r.remaining_kobo); left -= take;
    const rest = r.remaining_kobo - take;
    await t.query(`UPDATE commission_ledger SET remaining_kobo=$2, status=$3, settled_at=$4 WHERE id=$1`, [r.id, rest, rest > 0 ? 'ACCRUED' : kind === 'WAIVE' ? 'WAIVED' : 'SETTLED', rest > 0 ? null : now]);
    await t.query(`INSERT INTO ledger_applications (ledger_id, payment_id, kind, amount_kobo, reason, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [r.id, o.paymentId ?? null, kind, take, o.reason ?? null, now]);
  }
  return amount - left;
}

/** Called inside the transaction that CONFIRMS a payment. Applies the netted amount to the ledger once (idempotent per payment). */
export async function applyNettingForPayment(t: Conn, paymentId: number): Promise<number> {
  const p = await t.maybeOne<any>('SELECT id, barber_id, debt_netted_kobo FROM payments WHERE id=$1 FOR UPDATE', [paymentId]);
  if (!p || !p.barber_id || p.debt_netted_kobo <= 0) return 0;
  if (await t.maybeOne('SELECT 1 FROM ledger_applications WHERE payment_id=$1 AND kind IN (\'NETTED\',\'NETTED_REVERSED\') LIMIT 1', [paymentId])) return 0;
  const applied = await applyFifo(t, p.barber_id, p.debt_netted_kobo, 'NETTED', { paymentId, reason: 'netted against an in-app payment' });
  if (applied < p.debt_netted_kobo) await audit(t, null, { id: null, role: 'system' }, 'LEDGER_OVERNETTED', { payment_id: paymentId, barber_id: p.barber_id, netted_kobo: p.debt_netted_kobo, applied_kobo: applied, note: 'debt was settled/waived while checkout was open; barber share was reduced by the difference - review' });
  if (applied > 0) {
    const bu = await t.maybeOne<any>('SELECT user_id FROM barbers WHERE id=$1', [p.barber_id]);
    if (bu) await notify(t, bu.user_id, 'LEDGER_SETTLED', 'Platform balance updated', `${naira(applied)} of your platform commission was settled from an in-app payment. Remaining balance: ${naira(await outstandingKobo(t, p.barber_id))}.`);
  }
  return applied;
}

/** A refunded payment gives back what it settled: the debt returns to the ledger (idempotent). */
export async function reverseNettingForPayment(t: Conn, paymentId: number): Promise<number> {
  if (await t.maybeOne(`SELECT 1 FROM ledger_applications WHERE payment_id=$1 AND kind='NETTED_REVERSED' LIMIT 1`, [paymentId])) return 0;
  const apps = await t.many<any>(`SELECT id, ledger_id, amount_kobo FROM ledger_applications WHERE payment_id=$1 AND kind='NETTED' ORDER BY id`, [paymentId]);
  let total = 0; const now = isoNow();
  for (const a of apps) {
    await t.query(`UPDATE commission_ledger SET remaining_kobo = LEAST(amount_kobo, remaining_kobo + $2), status='ACCRUED', settled_at=NULL WHERE id=$1`, [a.ledger_id, a.amount_kobo]);
    await t.query(`INSERT INTO ledger_applications (ledger_id, payment_id, kind, amount_kobo, reason, created_at) VALUES ($1,$2,'NETTED_REVERSED',$3,'payment refunded',$4)`, [a.ledger_id, paymentId, a.amount_kobo, now]);
    total += a.amount_kobo;
  }
  if (total > 0) await audit(t, null, { id: null, role: 'system' }, 'LEDGER_NETTING_REVERSED', { payment_id: paymentId, amount_kobo: total });
  return total;
}

export const manualSettle = (t: Conn, barberId: number, amount: number, reason: string) => applyFifo(t, barberId, amount, 'MANUAL_SETTLE', { reason });
export const waive = (t: Conn, barberId: number, amount: number, reason: string) => applyFifo(t, barberId, amount, 'WAIVE', { reason });
export async function addAdjustment(t: Conn, barberId: number, amount: number, reason: string): Promise<number> {
  return (await t.one<{ id: number }>(`INSERT INTO commission_ledger (barber_id, booking_id, kind, amount_kobo, remaining_kobo, note, created_at) VALUES ($1,NULL,'ADJUSTMENT',$2,$2,$3,$4) RETURNING id`, [barberId, amount, reason, isoNow()])).id;
}

/** Has this barber exceeded the admin's debt limits? (Both limits 0 = never.) */
export async function ledgerBlocked(c: Conn, barberId: number, s?: Settings): Promise<{ blocked: boolean; outstanding_kobo: number; reason: string | null; oldest_days: number }> {
  const set = s ?? await getSettings(c);
  const out = await outstandingKobo(c, barberId);
  const oldest = await c.maybeOne<any>(`SELECT EXTRACT(EPOCH FROM ($2::timestamptz - MIN(created_at)))/86400 AS d FROM commission_ledger WHERE barber_id=$1 AND status='ACCRUED'`, [barberId, isoNow()]);
  const days = oldest?.d != null ? Math.max(0, Math.floor(Number(oldest.d))) : 0;
  let reason: string | null = null;
  if (set.commission_enabled && out > 0) {
    if (set.ledger_max_debt_kobo > 0 && out > set.ledger_max_debt_kobo) reason = `balance owed ${naira(out)} is above the limit of ${naira(set.ledger_max_debt_kobo)}`;
    else if (set.ledger_max_age_days > 0 && days >= set.ledger_max_age_days) reason = `balance has been owed for ${days} days (limit ${set.ledger_max_age_days})`;
  }
  return { blocked: !!reason, outstanding_kobo: out, reason, oldest_days: days };
}

/** Gatekeeping used when a customer books: maintenance, per-barber pause, pay-on-arrival switch + debt limits. */
export async function assertBookable(c: Conn, barberId: number, paymentOption: string) {
  const s = await getSettings(c);
  if (s.maintenance_mode) throw new AppError(503, 'MAINTENANCE', s.maintenance_message);
  const b = await c.maybeOne<any>('SELECT booking_paused, pause_reason FROM barbers WHERE id=$1', [barberId]);
  if (b?.booking_paused) throw new AppError(409, 'BARBER_PAUSED', 'This shop has paused new bookings for now. Please try again later.');
  if (paymentOption === 'ON_ARRIVAL') {
    if (!s.feature_pay_on_arrival) throw new AppError(409, 'PAY_ON_ARRIVAL_OFF', 'Pay on arrival is not available right now. Please pay online.');
    if ((await ledgerBlocked(c, barberId, s)).blocked) throw new AppError(409, 'PAY_ON_ARRIVAL_OFF', 'This shop only accepts online payment right now. Please pay online.');
  }
}

/** Reminder for barbers who owe a balance (sweeper + admin button). Returns how many were reminded; at most one reminder per barber per 3 days. */
export async function sendLedgerReminders(t: Conn, onlyBarberId?: number, force = false): Promise<number> {
  const s = await getSettings(t); if (!s.commission_enabled) return 0;
  const rows = await t.many<any>(`SELECT b.id, b.user_id, b.shop_name, SUM(l.remaining_kobo)::bigint AS owed, MIN(l.created_at) AS oldest FROM commission_ledger l JOIN barbers b ON b.id=l.barber_id
      WHERE l.status='ACCRUED' ${onlyBarberId ? 'AND b.id=$1' : ''} GROUP BY b.id, b.user_id, b.shop_name`, onlyBarberId ? [onlyBarberId] : []);
  let n = 0;
  for (const r of rows) {
    const blocked = await ledgerBlocked(t, r.id, s);
    const old = clock.now().getTime() - new Date(r.oldest).getTime() > 7 * 86400000;
    if (!force && !blocked.blocked && !old) continue;
    if (!force && await t.maybeOne(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='LEDGER_REMINDER' AND created_at > ($2::timestamptz - interval '3 days')`, [r.user_id, isoNow()])) continue;
    await notify(t, r.user_id, 'LEDGER_REMINDER', 'Platform balance owed', `${r.shop_name} owes ${naira(Number(r.owed))} in platform commission for bookings paid outside the app. It is deducted automatically from your next online payments.${blocked.blocked ? ' Pay on arrival is paused for your shop until this is settled.' : ''}`);
    n++;
  }
  return n;
}
