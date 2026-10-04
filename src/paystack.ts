import crypto from 'crypto';
import { Db } from './db';
import { config, MOCK_SECRET } from './config';
import { AppError, notFound } from './errors';
import { applyVerifiedPayment, assertPayoutReady, getBooking, PaymentOutcome, HoldVerdict } from './bookingService';
import { applyPlanPayment, getSettings, Settings } from './plans';
import { isoNow, clock } from './time';
import { audit, notify, naira } from './helpers';
import { applyNettingForPayment, planCheckoutSplit, previewBreakdown, reverseNettingForPayment } from './ledger';
import { FeeBreakdown } from './fees';
import { adminEvent, flushAdminPush } from './adminNotify';
import { logger } from './logger';

const PAYSTACK_API = 'https://api.paystack.co';

/* ---------- pure helpers (unit-tested) ---------- */
export function computeSignature(rawBody: Buffer | string, secret: string): string {
  return crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
}
export function verifySignature(rawBody: Buffer | string, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = computeSignature(rawBody, secret);
  const a = Buffer.from(expected, 'utf8'), b = Buffer.from(String(signature).toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function makeReference(bookingId: number): string {
  return `TS-BOOKING-${bookingId}-${crypto.randomBytes(5).toString('hex')}`;
}
export function bookingIdFromReference(ref: string): number | null {
  const m = /^TS-BOOKING-(\d+)-[a-f0-9]+$/.exec(ref || '');
  return m ? Number(m[1]) : null;
}
export function makePlanReference(purchaseId: number): string {
  return `TS-PLAN-${purchaseId}-${crypto.randomBytes(5).toString('hex')}`;
}
export function planIdFromReference(ref: string): number | null {
  const m = /^TS-PLAN-(\d+)-[a-f0-9]+$/.exec(ref || '');
  return m ? Number(m[1]) : null;
}
export interface VerifyResult { ok: boolean; status: string; amount_kobo?: number; requested_amount_kobo?: number; fees_kobo?: number; currency?: string; reference: string }

/** Paystack accounts can be set to pass the processing fee on to the customer. Then `amount` (what the customer paid) is the price GROSSED UP by the fee,
 *  and `requested_amount` is the price we asked for. We must compare the price we asked for, never the grossed-up total. Pure + unit-tested. */
export function parseGatewayData(d: any, reference: string): VerifyResult {
  const num = (v: unknown) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? undefined : Math.round(Number(v)));
  return { ok: d?.status === 'success', status: String(d?.status), amount_kobo: num(d?.amount), requested_amount_kobo: num(d?.requested_amount), fees_kobo: num(d?.fees), currency: d?.currency == null || d.currency === '' ? undefined : String(d.currency).toUpperCase(), reference };
}
/** Does what the gateway reports match the price on our payment row? Returns the processing fee the customer paid on top (0 if none), or null on a real mismatch. */
export function amountMatches(v: VerifyResult, expectedKobo: number): { fee_kobo: number; paid_kobo: number } | null {
  if (v.amount_kobo === undefined) return null;
  if (v.currency !== undefined && v.currency !== 'NGN') return null;    // we only ever charge Naira: a payment in any other currency is never confirmed
  const requested = v.requested_amount_kobo ?? v.amount_kobo;           // old/odd responses without requested_amount must match exactly
  if (requested !== expectedKobo) return null;
  if (v.amount_kobo < expectedKobo) return null;                        // underpaid
  const extra = v.amount_kobo - expectedKobo;
  if (extra > Math.max(20000, Math.round(expectedKobo * 0.08))) return null;   // a "fee" bigger than 8% / ₦200 is not a processing fee
  return { fee_kobo: extra, paid_kobo: v.amount_kobo };
}
let verifier: ((db: Db, reference: string) => Promise<VerifyResult>) | null = null;
/** Test hook: replace the gateway verification (never used in production code paths). */
export function setGatewayVerifier(fn: typeof verifier) { verifier = fn; }

export async function paystackFetch(path: string, init: RequestInit = {}) {
  let res: Response;
  try {
    res = await fetch(PAYSTACK_API + path, {
      ...init,
      signal: AbortSignal.timeout(9000),           // stay well inside the serverless function time limit
      headers: { Authorization: `Bearer ${config.paystackKey}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
  } catch (e: any) {   // timeout / DNS / connection reset: say so (and let callers retry) instead of an opaque 500
    throw new AppError(502, 'PAYSTACK_UNREACHABLE', 'We could not reach Paystack. Check your internet and try again.', { transient: true, gateway_message: String(e?.name || 'network') });
  }
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json.status === false) throw new AppError(502, 'PAYSTACK_ERROR', `Paystack error: ${json.message || res.statusText}`, { gateway_status: res.status, gateway_message: String(json.message || res.statusText || '').slice(0, 200), transient: res.status >= 500 || res.status === 429 });
  return json;
}

/** Start a payment for a PENDING_PAYMENT booking. Amount always comes from the booking's snapshotted price.
 *  The network call to Paystack happens OUTSIDE any DB transaction (a pooled connection is never held while waiting on the network). */
export async function initializePayment(db: Db, bookingId: number, customerEmail: string | null) {
  const b = (await getBooking(db, bookingId))!;
  if (b.status !== 'PENDING_PAYMENT' || b.payment_option !== 'ONLINE') throw new AppError(409, 'NOT_PAYABLE', 'This booking is not waiting for an online payment.');
  // Double click / two tabs: reuse the open checkout for this booking instead of starting a second one (two live checkouts could both be paid and the second would be a duplicate).
  // Two requests at the same instant would both see "no open checkout": the first to claim this 10-second slot goes on, the other waits a moment for its checkout to appear and re-uses it.
  const sec = 10000, bucket = new Date(Math.floor(clock.now().getTime() / sec) * sec).toISOString();
  const first = (await db.one<{ hits: number }>(`INSERT INTO rate_limits (key, window_start, hits) VALUES ($1,$2,1) ON CONFLICT (key, window_start) DO UPDATE SET hits = rate_limits.hits + 1 RETURNING hits`, [`init:${b.id}`, bucket])).hits === 1;
  const holdMin = Math.max(5, (await getSettings(db)).payment_hold_min);
  const findOpen = () => db.maybeOne<any>(`SELECT reference, authorization_url, amount_kobo, price_kobo, booking_fee_kobo, provider FROM payments WHERE booking_id=$1 AND status='INITIATED' AND authorization_url IS NOT NULL AND created_at > $2 ORDER BY id DESC LIMIT 1`,
    [b.id, new Date(clock.now().getTime() - holdMin * 60000).toISOString()]);
  let open = await findOpen();
  for (let i = 0; !open && !first && i < 10; i++) { await new Promise((r) => setTimeout(r, 400)); open = await findOpen(); }
  if (open && open.amount_kobo === b.price_kobo + (b.booking_fee_kobo || 0) && (open.provider === 'MOCK') === config.mockMode) {
    await extendHold(db, b.id);
    return { reference: open.reference, authorization_url: open.authorization_url, amount_kobo: open.amount_kobo, price_kobo: open.price_kobo, booking_fee_kobo: open.booking_fee_kobo, mock: open.provider === 'MOCK', reused: true };
  }
  const reference = makeReference(b.id);
  let bd = snapshotOf(b.price_kobo, b);
  if (!bd) {   // booking made before the fee model existed: compute the split now and store it, so the booking and the payment agree
    const barber = await db.one<any>('SELECT fee_percent_override, fee_flat_kobo_override FROM barbers WHERE id=$1', [b.barber_id]);
    bd = await previewBreakdown(db, barber, b.price_kobo);
    await db.query('UPDATE bookings SET booking_fee_kobo=$2, ps_fee_est_kobo=$3, barber_fee_kobo=$4, platform_charge_kobo=$5, payout_kobo=$6 WHERE id=$1', [b.id, bd.booking_fee_kobo, bd.ps_fee_kobo, bd.barber_fee_kobo, bd.platform_charge_kobo, bd.payout_kobo]);
  }
  const out = await startCheckout(db, { reference, bd, barberId: b.barber_id, email: customerEmail || `customer${b.customer_id}@trimslot.app`, metadata: { booking_id: b.id, app: 'trimslot' }, target: { booking_id: b.id } });
  await extendHold(db, b.id);
  return out;
}

/** The customer is on their way to pay: give them the full time again (the slot was never reserved, so this takes nothing from anyone). The attempt can never stay open longer than 4 times the normal time from when it was made. */
async function extendHold(db: Db, bookingId: number) {
  const holdMin = Math.max(1, (await getSettings(db)).payment_hold_min);
  const until = new Date(clock.now().getTime() + holdMin * 60000).toISOString();
  await db.query(`UPDATE bookings SET hold_expires_at = LEAST($2::timestamptz, created_at + make_interval(mins => $3)) WHERE id=$1 AND status='PENDING_PAYMENT' AND hold_expires_at IS NOT NULL AND hold_expires_at < $2::timestamptz`, [bookingId, until, holdMin * 4]);
}

/** Rebuild the breakdown frozen on a booking / plan purchase row. Null when the row predates the fee model (payout not stored). */
export function snapshotOf(priceKobo: number, r: { booking_fee_kobo: number; ps_fee_est_kobo: number; barber_fee_kobo: number; platform_charge_kobo: number; payout_kobo: number | null }): FeeBreakdown | null {
  if (r.payout_kobo === null || r.payout_kobo === undefined) return null;
  return { price_kobo: priceKobo, booking_fee_kobo: r.booking_fee_kobo, total_kobo: priceKobo + r.booking_fee_kobo, ps_fee_kobo: r.ps_fee_est_kobo, barber_fee_kobo: r.barber_fee_kobo,
    platform_share_kobo: Math.max(0, r.ps_fee_est_kobo - r.booking_fee_kobo - r.barber_fee_kobo), platform_charge_kobo: r.platform_charge_kobo, payout_kobo: r.payout_kobo,
    platform_net_kobo: r.booking_fee_kobo + r.barber_fee_kobo + r.platform_charge_kobo - r.ps_fee_est_kobo };
}

/** Shared by booking payments and plan purchases: same Paystack initialize call, subaccount split and payments row. The customer is charged `bd.total_kobo` (price + booking fee). */
async function startCheckout(db: Db, o: { reference: string; bd: FeeBreakdown; barberId: number; email: string; metadata: any; target: { booking_id?: number; plan_purchase_id?: number } }) {
  const { reference, bd } = o;
  const amount = bd.total_kobo;
  const barber = await db.one<any>('SELECT id, paystack_subaccount, fee_percent_override, fee_flat_kobo_override FROM barbers WHERE id=$1', [o.barberId]);
  assertPayoutReady(barber);
  const subaccount: string | null = barber.paystack_subaccount || null;
  const { fee, netted, charge } = await planCheckoutSplit(db, barber, bd);
  let authUrl: string;
  let provider: 'PAYSTACK' | 'MOCK';
  if (config.mockMode) {
    provider = 'MOCK';
    authUrl = `${config.appBaseUrl}/mock-checkout.html?reference=${encodeURIComponent(reference)}`;
  } else {
    provider = 'PAYSTACK';
    const payload: any = { email: o.email, amount, currency: 'NGN', reference, callback_url: `${config.appBaseUrl}/api/payments/callback`, metadata: o.metadata };
    if (subaccount) {
      // Paystack splits NOTHING by itself: we tell it exactly how much stays with the platform account (everything except the barber's payout).
      // bearer 'account' = the platform account pays Paystack's fee out of what it keeps; that is the fee the three shares were calculated for.
      payload.subaccount = subaccount;
      payload.bearer = 'account';
      payload.transaction_charge = charge;
    }
    const json = await paystackFetch('/transaction/initialize', { method: 'POST', body: JSON.stringify(payload) });
    authUrl = json.data.authorization_url;
  }
  await db.query(`INSERT INTO payments (booking_id, plan_purchase_id, reference, provider, amount_kobo, fee_kobo, subaccount, status, authorization_url, created_at, barber_id, debt_netted_kobo,
      price_kobo, booking_fee_kobo, barber_fee_kobo, ps_fee_est_kobo, payout_kobo) VALUES ($1,$2,$3,$4,$5,$6,$7,'INITIATED',$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [o.target.booking_id ?? null, o.target.plan_purchase_id ?? null, reference, provider, amount, fee, subaccount, authUrl, isoNow(), o.barberId, netted,
      bd.price_kobo, bd.booking_fee_kobo, bd.barber_fee_kobo, bd.ps_fee_kobo, bd.payout_kobo - netted]);
  return { reference, authorization_url: authUrl, amount_kobo: amount, price_kobo: bd.price_kobo, booking_fee_kobo: bd.booking_fee_kobo, mock: provider === 'MOCK' };
}

/** Customer starts buying a plan. A PENDING purchase row is created (invisible to the barber, worthless until paid); amount/terms are snapshotted server-side. */
export async function initializePlanPurchase(db: Db, customerId: number, planId: number, customerEmail: string | null) {
  { const st = await getSettings(db);
    if (st.maintenance_mode) throw new AppError(503, 'MAINTENANCE', st.maintenance_message);
    if (!st.feature_plans) throw new AppError(409, 'FEATURE_OFF', 'Plans are off right now.'); }
  const plan = await db.maybeOne<any>(`SELECT p.*, b.paystack_subaccount, b.fee_percent_override, b.fee_flat_kobo_override, COALESCE((SELECT array_agg(ps.service_id) FROM plan_services ps WHERE ps.plan_id=p.id),'{}') AS service_ids
    FROM plans p JOIN barbers b ON b.id=p.barber_id WHERE p.id=$1 AND p.active AND b.verified`, [planId]);
  if (!plan) throw notFound('We could not find that plan.');
  assertPayoutReady(plan);
  if (!plan.service_ids || !plan.service_ids.length) throw new AppError(409, 'PLAN_NO_SERVICES', 'This plan has no services yet, so you cannot buy it. Ask the barber to fix it.');
  const bd = await previewBreakdown(db, plan, plan.price_kobo);
  const purchase = await db.one<{ id: number }>(`INSERT INTO plan_purchases (plan_id, customer_id, barber_id, plan_name, price_kobo, sessions_total, validity_days, service_ids, created_at, session_value_kobo,
      booking_fee_kobo, ps_fee_est_kobo, barber_fee_kobo, platform_charge_kobo, payout_kobo)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`, [plan.id, customerId, plan.barber_id, plan.name, plan.price_kobo, plan.sessions, plan.validity_days, plan.service_ids, isoNow(), Math.floor(plan.price_kobo / plan.sessions),
      bd.booking_fee_kobo, bd.ps_fee_kobo, bd.barber_fee_kobo, bd.platform_charge_kobo, bd.payout_kobo]);
  const out = await startCheckout(db, { reference: makePlanReference(purchase.id), bd, barberId: plan.barber_id,
    email: customerEmail || `customer${customerId}@trimslot.app`, metadata: { plan_purchase_id: purchase.id, app: 'trimslot' }, target: { plan_purchase_id: purchase.id } });
  return { ...out, purchase_id: purchase.id };
}

/** Ask Paystack (server-side) whether `reference` was paid. In MOCK mode (non-production only) the "gateway" is our own mock_paid flag. */
export async function verifyWithGateway(db: Db, reference: string): Promise<VerifyResult> {
  if (verifier) return verifier(db, reference);
  if (config.mockMode) {
    const p = await db.maybeOne('SELECT * FROM payments WHERE reference=$1', [reference]);
    if (!p) return { ok: false, status: 'not_found', reference };
    return { ok: !!p.mock_paid, status: p.mock_paid ? 'success' : 'abandoned', amount_kobo: p.amount_kobo, reference };
  }
  const json = await paystackFetch(`/transaction/verify/${encodeURIComponent(reference)}`);
  const v = parseGatewayData(json.data || {}, reference);
  if (v.currency === undefined) v.currency = 'MISSING';        // a real Paystack answer always names the currency; one that does not is not trusted
  return v;
}

/** What happened to a payment. Each case has its own text on the return page:
 *  processed / already_processed = the booking is confirmed; slot_taken = someone else's payment took the time first; late_refund = the payment came after the
 *  try closed and the time was no longer free; duplicate_refund = a second payment for a booking that was already paid; refund_due = a duplicate plan payment. */
export type ProcessResult = 'processed' | 'already_processed' | 'not_paid' | 'unknown_reference' | 'amount_mismatch' | 'slot_taken' | 'late_refund' | 'duplicate_refund' | 'refund_due';

/** A payment that was already settled earlier (webhook first, or a second tab): say what really happened to it, not just "already processed". */
async function settledResult(db: Db, pay: any): Promise<ProcessResult> {
  const reason = String(pay.refund_reason || '');
  if (pay.plan_purchase_id) return pay.refund_status && /^Duplicate payment/i.test(reason) ? 'refund_due' : 'already_processed';
  if (pay.refund_status && /^Slot was taken/i.test(reason)) return 'slot_taken';
  if (pay.refund_status && /^Duplicate payment/i.test(reason)) return 'duplicate_refund';
  if (pay.refund_status && /^Payment arrived after/i.test(reason)) return 'late_refund';
  return 'already_processed';
}

export const MISMATCH_REASON = 'Amount mismatch';
/** The amount (or currency) Paystack reports does not fit this booking. Never confirm it by itself: tell the customer once, raise an admin alert, and leave the money for staff to refund or confirm. */
async function flagMismatch(db: Db, pay: any, v: VerifyResult) {
  // Flag the money for staff (once): the payment row says NEEDS_REFUND / "Amount mismatch" so it shows in Payments and in the open-refunds count. The sweeper does NOT auto-refund this reason: staff choose to refund it or to confirm it anyway.
  await db.query(`UPDATE payments SET refund_status='NEEDS_REFUND', refund_reason=$2 WHERE reference=$1 AND refund_status IS NULL AND status<>'SUCCESS'`, [pay.reference, MISMATCH_REASON]);
  if (!pay.booking_id) { await adminEvent(db, 'PAYMENT_MISMATCH', 'A plan payment did not match', `Payment ${pay.reference} reported ${v.amount_kobo ?? '?'} kobo (${v.currency ?? 'no currency'}) but we asked for ${pay.amount_kobo}. It was not applied. Check it in Payments.`, { link: '/admin.html#/payments', refKey: 'mismatch:' + pay.reference, dedupeHours: 24 }); return; }
  await db.tx(async (t) => {
    const b = await t.maybeOne<any>('SELECT id, customer_id, service_name FROM bookings WHERE id=$1', [pay.booking_id]);
    if (!b) return;
    if (await t.maybeOne(`SELECT 1 FROM audit_log WHERE booking_id=$1 AND action='PAYMENT_AMOUNT_MISMATCH' AND details::text LIKE $2 LIMIT 1`, [b.id, `%${pay.reference}%`])) return;
    await audit(t, b.id, { id: null, role: 'system' }, 'PAYMENT_AMOUNT_MISMATCH', { reference: pay.reference, asked_kobo: pay.amount_kobo, reported_kobo: v.amount_kobo ?? null, requested_kobo: v.requested_amount_kobo ?? null, currency: v.currency ?? null, note: 'gateway amount or currency does not fit this booking - NOT confirmed; staff must refund or confirm' });
    await notify(t, b.customer_id, 'PAYMENT_PROBLEM', 'We need to check your payment', `We received a payment for your ${b.service_name}, but the amount was not what we asked for, so we did not confirm the booking. Our team will check it and either confirm the booking or refund you. Please keep your booking number #${b.id}.`, b.id);
  });
  await adminEvent(db, 'PAYMENT_MISMATCH', 'A payment did not match its booking', `Payment ${pay.reference} for booking #${pay.booking_id} reported ${v.amount_kobo ?? '?'} kobo${v.currency && v.currency !== 'NGN' ? ' in ' + v.currency : ''} but we asked for ${pay.amount_kobo}. The booking was NOT confirmed. Open Payments to refund it or confirm it.`,
    { link: '/admin.html#/payments', refKey: 'mismatch:' + pay.reference, dedupeHours: 24 });
  await flushAdminPush(db).catch(() => {});
}

/**
 * Verify a reference and (idempotently) apply it: confirm the booking, or activate the plan purchase. Safe to call repeatedly / concurrently from
 * callback + webhook (and from several serverless instances at once): the payment row is claimed with a conditional UPDATE inside the same
 * transaction that applies it, so exactly one caller wins and the rest see 'already_processed'.
 * If the money cannot be honoured (slot taken meanwhile, duplicate, late) the booking is NOT confirmed, the payment is flagged NEEDS_REFUND
 * and - after the transaction has committed - a gateway refund is requested (best effort; the flag stays if that fails).
 */
export async function processReference(db: Db, reference: string, o: { force?: boolean } = {}): Promise<{ result: ProcessResult; booking_id?: number; plan_purchase_id?: number }> {
  const pay = await db.maybeOne('SELECT * FROM payments WHERE reference=$1', [reference]);
  if (!pay) return { result: 'unknown_reference' };
  const ids = { booking_id: pay.booking_id ?? undefined, plan_purchase_id: pay.plan_purchase_id ?? undefined };
  if (pay.status === 'SUCCESS') return { result: await settledResult(db, pay), ...ids };
  const v = await verifyWithGateway(db, reference);            // network call: no DB transaction is open here
  if (!v.ok) return { result: 'not_paid', ...ids };
  // `force` (admin "confirm anyway") accepts a different AMOUNT for a payment staff have looked at, never another currency.
  const am = amountMatches(v, pay.amount_kobo) ?? (o.force && v.amount_kobo !== undefined && (v.currency === undefined || v.currency === 'NGN') ? { fee_kobo: 0, paid_kobo: v.amount_kobo } : null);
  if (!am) { await flagMismatch(db, pay, v).catch((e) => logger.warn('mismatch_flag_failed', { err: String(e?.message).slice(0, 120) })); return { result: 'amount_mismatch', ...ids }; }
  const outcome = await db.tx(async (t): Promise<PaymentOutcome | 'activated' | 'already_active' | null> => {
    const claim = await t.query(`UPDATE payments SET status='SUCCESS', verified_at=$2, paid_kobo=$3, gateway_fee_kobo=$4, ps_fee_actual_kobo=$5,
        refund_status = CASE WHEN refund_status='NEEDS_REFUND' AND refund_reason='${MISMATCH_REASON}' THEN NULL ELSE refund_status END,
        refund_reason = CASE WHEN refund_status='NEEDS_REFUND' AND refund_reason='${MISMATCH_REASON}' THEN NULL ELSE refund_reason END
      WHERE reference=$1 AND status<>'SUCCESS'`, [reference, isoNow(), am.paid_kobo, am.fee_kobo, v.fees_kobo && v.fees_kobo > 0 ? v.fees_kobo : null]);
    if (claim.rowCount !== 1) return null;                     // someone else already processed it
    if (pay.plan_purchase_id) {
      const r = await applyPlanPayment(t, pay.plan_purchase_id);
      if (r === 'already_active') await t.query(`UPDATE payments SET refund_status='NEEDS_REFUND', refund_reason='Duplicate payment for an already-active plan' WHERE reference=$1`, [reference]);
      else await applyNettingForPayment(t, pay.id);
      return r;
    }
    const o = await applyVerifiedPayment(t, pay.booking_id, 'PAYSTACK', reference);
    if (o === 'confirmed') await applyNettingForPayment(t, pay.id);
    return o;
  });
  if (outcome === null) return { result: await settledResult(db, (await db.maybeOne('SELECT * FROM payments WHERE reference=$1', [reference])) ?? pay), ...ids };
  const needsRefund = outcome === 'slot_taken' || outcome === 'late_payment' || outcome === 'already_paid' || outcome === 'already_active';
  if (needsRefund) await requestRefund(db, reference);
  const result: ProcessResult = outcome === 'slot_taken' ? 'slot_taken' : outcome === 'late_payment' ? 'late_refund' : outcome === 'already_paid' ? 'duplicate_refund' : needsRefund ? 'refund_due' : 'processed';
  return { result, ...ids };
}

/** Ask the gateway to refund a payment flagged NEEDS_REFUND. Runs OUTSIDE any DB transaction. Never throws: on failure the payment simply stays NEEDS_REFUND with the error noted. */
export async function requestRefund(db: Db, reference: string): Promise<'requested' | 'failed' | 'not_needed'> {
  // Claim first: two callers (the sweeper and an admin click, or two sweepers) can never both send the refund. Only the one whose UPDATE changes the row goes on.
  const claim = await db.maybeOne<{ id: number }>(`UPDATE payments SET refund_status='REFUND_REQUESTED', refund_requested_at=$2, refund_error=NULL WHERE reference=$1 AND refund_status='NEEDS_REFUND' RETURNING id`, [reference, isoNow()]);
  if (!claim) return 'not_needed';
  try {
    if (!config.mockMode) await paystackFetch('/refund', { method: 'POST', body: JSON.stringify({ transaction: reference }) });
  } catch (e: any) {
    // The gateway refused or was unreachable: hand the claim back so the next try (sweeper / admin) can go again.
    await db.query(`UPDATE payments SET refund_status='NEEDS_REFUND', refund_requested_at=NULL, refund_error=$2 WHERE id=$1 AND refund_status='REFUND_REQUESTED'`, [claim.id, String(e?.message || 'refund failed').slice(0, 300)]).catch(() => {});
    // alert the admin once per payment per 12 h (the sweeper retries every minute; one alert is enough)
    await adminEvent(db, 'REFUND_FAILED', 'Paystack could not send the refund', `The refund for payment ${reference} did not go through (${String(e?.message || 'unknown error').slice(0, 120)}). We will try again by ourselves. Check Payments if it keeps failing.`,
      { link: '/admin.html#/payments?filter=needs_refund', refKey: 'payment:' + reference, dedupeHours: 12 });
    await flushAdminPush(db).catch(() => {});
    return 'failed';
  }
  // The money is on its way. Giving back the commission the payment had settled must not undo that, so a failure here is logged, not turned into a second refund.
  await db.tx((t) => reverseNettingForPayment(t, claim.id)).catch((e) => logger.warn('refund_netting_reverse_failed', { ref: reference, err: String(e?.message).slice(0, 120) }));
  return 'requested';
}

/** Record a webhook/callback delivery. Identical deliveries (same bytes, same signature validity) collapse into one row (delivery_count++). */
export async function recordPaymentEvent(db: Db, e: { source: 'WEBHOOK' | 'CALLBACK'; eventType: string | null; reference: string | null; signatureValid: boolean | null; payload: string; result: string }) {
  const key = crypto.createHash('sha256').update(`${e.source}|${e.signatureValid}|`).update(e.payload).digest('hex');
  await db.query(
    `INSERT INTO payment_events (source, event_key, event_type, reference, signature_valid, payload, result, last_result)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
     ON CONFLICT (event_key) DO UPDATE SET
       delivery_count = payment_events.delivery_count + 1,
       last_received_at = now(),
       last_result = EXCLUDED.last_result,
       result = CASE WHEN EXCLUDED.result = 'processed' AND payment_events.result <> 'processed' THEN 'processed' ELSE payment_events.result END`,
    [e.source, key, e.eventType, e.reference, e.signatureValid, e.payload.slice(0, e.signatureValid === false ? 1000 : 20000), e.result]);
}

/** Webhook handler core (raw body + signature already extracted). Returns HTTP status to send. */
export async function handleWebhook(db: Db, rawBody: Buffer, signature: string | undefined): Promise<{ status: number; body: any }> {
  const valid = verifySignature(rawBody, signature, config.webhookSecret);
  const text = rawBody.toString('utf8');
  let event: any = null;
  try { event = JSON.parse(text); } catch { /* keep null */ }
  const reference: string | null = typeof event?.data?.reference === 'string' ? event.data.reference : null;
  const log = (result: string) => recordPaymentEvent(db, { source: 'WEBHOOK', eventType: event?.event ?? null, reference, signatureValid: valid, payload: text, result });
  if (!valid) { await log('rejected_bad_signature'); return { status: 401, body: { error: 'Invalid signature' } }; }
  if (!event) { await log('rejected_bad_json'); return { status: 400, body: { error: 'Invalid JSON' } }; }
  if (event.event !== 'charge.success' || !reference) { await log('ignored'); return { status: 200, body: { received: true, ignored: true } }; }
  try {
    // Never trust the payload's word: re-verify the reference with the gateway.
    const r = await processReference(db, reference);
    await log(r.result);
    return { status: 200, body: { received: true, result: r.result } };
  } catch (e: any) {
    try { await log('error: ' + (e.message || 'unknown')); } catch { /* db down */ }
    return { status: 500, body: { error: 'That did not work. Please try again.' } }; // Paystack retries on non-200
  }
}

/** MOCK mode only: the fake checkout page marks the reference as paid, then (like the real flow) we still verify. */
export async function mockMarkPaid(db: Db, reference: string) {
  if (!config.mockMode) throw new AppError(404, 'NOT_FOUND', 'Test checkout is off.');
  const r = await db.query('UPDATE payments SET mock_paid=TRUE WHERE reference=$1', [reference]);
  if (!r.rowCount) throw notFound('We do not know that payment reference.');
}

export { MOCK_SECRET };

/* ---------- never close an attempt without asking Paystack ---------- */
/** At most one gateway check per reference per time bucket, shared by all server instances (uses the rate_limits table; rows are cleaned up by the retention job).
 *  A second marker (`reconok:`) records that the check ANSWERED. A check that failed keeps its claim (so we back off for the whole bucket instead of asking a broken gateway on every request)
 *  but leaves no marker, and everyone who meets that claim treats the payment as "not checked yet", never as "not paid". */
async function claimCheck(db: Db, reference: string, bucketMin: number): Promise<{ claimed: boolean; answered: () => Promise<void>; wasAnswered: () => Promise<boolean> }> {
  const ms = bucketMin * 60000, bucket = new Date(Math.floor(clock.now().getTime() / ms) * ms).toISOString();
  const r = await db.one<{ hits: number }>(`INSERT INTO rate_limits (key, window_start, hits) VALUES ($1,$2,1) ON CONFLICT (key, window_start) DO UPDATE SET hits = rate_limits.hits + 1 RETURNING hits`, [`recon:${reference}`, bucket]);
  return {
    claimed: r.hits === 1,
    answered: async () => { await db.query(`INSERT INTO rate_limits (key, window_start, hits) VALUES ($1,$2,1) ON CONFLICT (key, window_start) DO NOTHING`, [`reconok:${reference}`, bucket]).catch(() => {}); },
    wasAnswered: async () => !!(await db.maybeOne(`SELECT 1 FROM rate_limits WHERE key=$1 AND window_start=$2`, [`reconok:${reference}`, bucket]).catch(() => null)),
  };
}

/** Called just before timed-out Pay-now attempts are closed. For each one we ask Paystack about every open checkout: a payment whose webhook never reached us and whose
 *  browser was closed is confirmed here (or refunded if the time is gone) instead of being voided with the customer's money taken.
 *  `keep` = attempts we could not check yet (Paystack unreachable, out of time, or an amount that needs staff) and that ended less than an hour ago: leave them open and try again.
 *  `unverified` = closed anyway after that hour without an answer: the customer is told the truth about it (`mismatch` = a payment that did not fit the booking, staff are checking it).
 *  The whole call is capped (`budgetMs`): this runs on ordinary requests, so a slow Paystack must not hold them up. */
export async function verifyBeforeClosing(db: Db, rows: { id: number; hold_expires_at: string }[], o: { budgetMs?: number } = {}): Promise<HoldVerdict> {
  const keep = new Set<number>(), unverified = new Set<number>(), mismatch = new Set<number>();
  const deadline = Date.now() + (o.budgetMs ?? 7000);
  for (const row of rows) {
    const pays = await db.many<{ reference: string; refund_reason: string | null }>(`SELECT reference, refund_reason FROM payments WHERE booking_id=$1 AND status='INITIATED' ORDER BY id DESC LIMIT 5`, [row.id]);
    let failed = false, odd = false;
    for (const p of pays) {
      if (p.refund_reason === MISMATCH_REASON) { odd = true; continue; }        // already flagged for staff
      const c = await claimCheck(db, p.reference, 2);
      if (!c.claimed) { if (!(await c.wasAnswered())) failed = true; continue; }   // asked a moment ago: fine if it answered, otherwise it is still unknown
      if (Date.now() > deadline) { failed = true; continue; }                       // out of time: leave the claim, try again later
      try { const r = await processReference(db, p.reference); await c.answered(); if (r.result === 'amount_mismatch') odd = true; }
      catch (e: any) { failed = true; logger.warn('hold_verify_failed', { ref: p.reference, err: String(e?.message).slice(0, 120) }); }
    }
    if (failed || odd) {
      if (clock.now().getTime() - new Date(row.hold_expires_at).getTime() < 60 * 60000) keep.add(row.id);
      else { unverified.add(row.id); if (odd) mismatch.add(row.id); }
    }
  }
  return { keep, unverified, mismatch };
}

/** Sweep step: open checkouts from the last 48 hours whose booking was closed (or is still waiting) are asked about again, so a payment that arrived after the
 *  attempt closed is confirmed (time still free) or refunded, never just forgotten. Each reference is asked at most every 10 minutes (a failed ask also waits that long). */
export async function reconcileRecentPayments(db: Db, limit = 25): Promise<{ checked: number; confirmed: number; refunds: number }> {
  const holdMin = Math.max(1, (await getSettings(db)).payment_hold_min);
  const now = clock.now().getTime();
  const rows = await db.many<{ reference: string }>(`SELECT p.reference FROM payments p JOIN bookings b ON b.id=p.booking_id
      WHERE p.status='INITIATED' AND p.refund_status IS NULL AND b.status IN ('CANCELLED','PENDING_PAYMENT') AND p.created_at > $1 AND p.created_at < $2 ORDER BY p.id DESC LIMIT $3`,
    [new Date(now - RECONCILE_HOURS * 3600000).toISOString(), new Date(now - holdMin * 60000).toISOString(), limit * 4]);
  let checked = 0, confirmed = 0, refunds = 0;
  const deadline = Date.now() + 20000;
  for (const r of rows) {
    if (checked >= limit || Date.now() > deadline) break;
    const c = await claimCheck(db, r.reference, 10);
    if (!c.claimed) continue;
    checked++;
    try {
      const o = await processReference(db, r.reference);
      await c.answered();
      if (o.result === 'processed') confirmed++; else if (['slot_taken', 'late_refund', 'duplicate_refund', 'refund_due'].includes(o.result)) refunds++;
    } catch (e: any) { logger.warn('reconcile_failed', { ref: r.reference, err: String(e?.message).slice(0, 120) }); }
  }
  return { checked, confirmed, refunds };
}
export const RECONCILE_HOURS = 48;
