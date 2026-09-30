import crypto from 'crypto';
import { Db } from './db';
import { config, MOCK_SECRET } from './config';
import { AppError, notFound } from './errors';
import { applyVerifiedPayment, getBooking, PaymentOutcome } from './bookingService';
import { applyPlanPayment, getSettings, Settings } from './plans';
import { isoNow } from './time';
import { applyNettingForPayment, inAppFeeKobo, planCheckoutSplit, reverseNettingForPayment } from './ledger';

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
/** Platform fee kept from a charge. Admin settings (platform_settings) win; when they are 0/0 the PLATFORM_FEE_* env vars still apply. */
export function platformFeeKobo(priceKobo: number, s?: Pick<Settings, 'platform_fee_kobo' | 'platform_fee_percent'>): number {
  const useSettings = !!s && (s.platform_fee_kobo > 0 || Number(s.platform_fee_percent) > 0);
  const flat = useSettings ? s!.platform_fee_kobo : config.platformFeeKobo;
  const pct = useSettings ? Number(s!.platform_fee_percent) : config.platformFeePercent;
  return Math.min(flat + Math.round((priceKobo * pct) / 100), priceKobo);
}

export interface VerifyResult { ok: boolean; status: string; amount_kobo?: number; reference: string }

async function paystackFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(PAYSTACK_API + path, {
    ...init,
    signal: AbortSignal.timeout(9000),           // stay well inside the serverless function time limit
    headers: { Authorization: `Bearer ${config.paystackKey}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json.status === false) throw new AppError(502, 'PAYSTACK_ERROR', `Paystack error: ${json.message || res.statusText}`);
  return json;
}

/** Start a payment for a PENDING_PAYMENT booking. Amount always comes from the booking's snapshotted price.
 *  The network call to Paystack happens OUTSIDE any DB transaction (a pooled connection is never held while waiting on the network). */
export async function initializePayment(db: Db, bookingId: number, customerEmail: string | null) {
  const b = (await getBooking(db, bookingId))!;
  if (b.status !== 'PENDING_PAYMENT' || b.payment_option !== 'ONLINE') throw new AppError(409, 'NOT_PAYABLE', 'This booking is not awaiting online payment.');
    const reference = makeReference(b.id);
  return startCheckout(db, { reference, amount: b.price_kobo, barberId: b.barber_id, email: customerEmail || `customer${b.customer_id}@trimslot.app`, metadata: { booking_id: b.id, app: 'trimslot' }, target: { booking_id: b.id } });
}

/** Shared by booking payments and plan purchases: same Paystack initialize call, subaccount + platform-fee split, and payments row. */
async function startCheckout(db: Db, o: { reference: string; amount: number; barberId: number; email: string; metadata: any; target: { booking_id?: number; plan_purchase_id?: number } }) {
  const { reference, amount } = o;
  const barber = await db.one<any>('SELECT id, paystack_subaccount, fee_percent_override, fee_flat_kobo_override FROM barbers WHERE id=$1', [o.barberId]);
  const subaccount: string | null = barber.paystack_subaccount || null;
  const { fee, netted, charge } = await planCheckoutSplit(db, barber, amount);
  let authUrl: string;
  let provider: 'PAYSTACK' | 'MOCK';
  if (config.mockMode) {
    provider = 'MOCK';
    authUrl = `${config.appBaseUrl}/mock-checkout.html?reference=${encodeURIComponent(reference)}`;
  } else {
    provider = 'PAYSTACK';
    const payload: any = { email: o.email, amount, currency: 'NGN', reference, callback_url: `${config.appBaseUrl}/api/payments/callback`, metadata: o.metadata };
    if (subaccount) {
      payload.subaccount = subaccount;
      if (charge > 0) payload.transaction_charge = charge; // platform keeps the fee (+ any commission debt netted), subaccount gets the rest
    }
    const json = await paystackFetch('/transaction/initialize', { method: 'POST', body: JSON.stringify(payload) });
    authUrl = json.data.authorization_url;
  }
  await db.query(`INSERT INTO payments (booking_id, plan_purchase_id, reference, provider, amount_kobo, fee_kobo, subaccount, status, authorization_url, created_at, barber_id, debt_netted_kobo) VALUES ($1,$2,$3,$4,$5,$6,$7,'INITIATED',$8,$9,$10,$11)`,
    [o.target.booking_id ?? null, o.target.plan_purchase_id ?? null, reference, provider, amount, fee, subaccount, authUrl, isoNow(), o.barberId, netted]);
  return { reference, authorization_url: authUrl, amount_kobo: amount, mock: provider === 'MOCK' };
}

/** Customer starts buying a plan. A PENDING purchase row is created (invisible to the barber, worthless until paid); amount/terms are snapshotted server-side. */
export async function initializePlanPurchase(db: Db, customerId: number, planId: number, customerEmail: string | null) {
  { const st = await getSettings(db);
    if (st.maintenance_mode) throw new AppError(503, 'MAINTENANCE', st.maintenance_message);
    if (!st.feature_plans) throw new AppError(409, 'FEATURE_OFF', 'Plans are switched off right now.'); }
  const plan = await db.maybeOne<any>(`SELECT p.*, b.paystack_subaccount, COALESCE((SELECT array_agg(ps.service_id) FROM plan_services ps WHERE ps.plan_id=p.id),'{}') AS service_ids
    FROM plans p JOIN barbers b ON b.id=p.barber_id WHERE p.id=$1 AND p.active AND b.verified`, [planId]);
  if (!plan) throw notFound('Plan not found');
  const purchase = await db.one<{ id: number }>(`INSERT INTO plan_purchases (plan_id, customer_id, barber_id, plan_name, price_kobo, sessions_total, validity_days, service_ids, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [plan.id, customerId, plan.barber_id, plan.name, plan.price_kobo, plan.sessions, plan.validity_days, plan.service_ids, isoNow()]);
  const out = await startCheckout(db, { reference: makePlanReference(purchase.id), amount: plan.price_kobo, barberId: plan.barber_id,
    email: customerEmail || `customer${customerId}@trimslot.app`, metadata: { plan_purchase_id: purchase.id, app: 'trimslot' }, target: { plan_purchase_id: purchase.id } });
  return { ...out, purchase_id: purchase.id };
}

/** Ask Paystack (server-side) whether `reference` was paid. In MOCK mode (non-production only) the "gateway" is our own mock_paid flag. */
export async function verifyWithGateway(db: Db, reference: string): Promise<VerifyResult> {
  if (config.mockMode) {
    const p = await db.maybeOne('SELECT * FROM payments WHERE reference=$1', [reference]);
    if (!p) return { ok: false, status: 'not_found', reference };
    return { ok: !!p.mock_paid, status: p.mock_paid ? 'success' : 'abandoned', amount_kobo: p.amount_kobo, reference };
  }
  const json = await paystackFetch(`/transaction/verify/${encodeURIComponent(reference)}`);
  const d = json.data || {};
  return { ok: d.status === 'success', status: String(d.status), amount_kobo: d.amount, reference };
}

export type ProcessResult = 'processed' | 'already_processed' | 'not_paid' | 'unknown_reference' | 'amount_mismatch' | 'slot_taken' | 'refund_due';

/**
 * Verify a reference and (idempotently) apply it: confirm the booking, or activate the plan purchase. Safe to call repeatedly / concurrently from
 * callback + webhook (and from several serverless instances at once): the payment row is claimed with a conditional UPDATE inside the same
 * transaction that applies it, so exactly one caller wins and the rest see 'already_processed'.
 * If the money cannot be honoured (slot taken meanwhile, duplicate, late) the booking is NOT confirmed, the payment is flagged NEEDS_REFUND
 * and - after the transaction has committed - a gateway refund is requested (best effort; the flag stays if that fails).
 */
export async function processReference(db: Db, reference: string): Promise<{ result: ProcessResult; booking_id?: number; plan_purchase_id?: number }> {
  const pay = await db.maybeOne('SELECT * FROM payments WHERE reference=$1', [reference]);
  if (!pay) return { result: 'unknown_reference' };
  const ids = { booking_id: pay.booking_id ?? undefined, plan_purchase_id: pay.plan_purchase_id ?? undefined };
  if (pay.status === 'SUCCESS') return { result: 'already_processed', ...ids };
  const v = await verifyWithGateway(db, reference);            // network call: no DB transaction is open here
  if (!v.ok) return { result: 'not_paid', ...ids };
  if (v.amount_kobo !== pay.amount_kobo) return { result: 'amount_mismatch', ...ids };
  const outcome = await db.tx(async (t): Promise<PaymentOutcome | 'activated' | 'already_active' | null> => {
    const claim = await t.query(`UPDATE payments SET status='SUCCESS', verified_at=$2 WHERE reference=$1 AND status<>'SUCCESS'`, [reference, isoNow()]);
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
  if (outcome === null) return { result: 'already_processed', ...ids };
  const needsRefund = outcome === 'slot_taken' || outcome === 'late_payment' || outcome === 'already_paid' || outcome === 'already_active';
  if (needsRefund) await requestRefund(db, reference);
  return { result: outcome === 'slot_taken' ? 'slot_taken' : needsRefund ? 'refund_due' : 'processed', ...ids };
}

/** Ask the gateway to refund a payment flagged NEEDS_REFUND. Runs OUTSIDE any DB transaction. Never throws: on failure the payment simply stays NEEDS_REFUND with the error noted. */
export async function requestRefund(db: Db, reference: string): Promise<'requested' | 'failed' | 'not_needed'> {
  const p = await db.maybeOne('SELECT refund_status FROM payments WHERE reference=$1', [reference]);
  if (!p || p.refund_status !== 'NEEDS_REFUND') return 'not_needed';
  try {
    if (!config.mockMode) await paystackFetch('/refund', { method: 'POST', body: JSON.stringify({ transaction: reference }) });
    await db.tx(async (t) => {
      await t.query(`UPDATE payments SET refund_status='REFUND_REQUESTED', refund_requested_at=$2, refund_error=NULL WHERE reference=$1`, [reference, isoNow()]);
      const pid = await t.maybeOne<{ id: number }>('SELECT id FROM payments WHERE reference=$1', [reference]);
      if (pid) await reverseNettingForPayment(t, pid.id);          // a refunded payment gives back the commission it had settled
    });
    return 'requested';
  } catch (e: any) {
    await db.query(`UPDATE payments SET refund_error=$2 WHERE reference=$1`, [reference, String(e?.message || 'refund failed').slice(0, 300)]).catch(() => {});
    return 'failed';
  }
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
    return { status: 500, body: { error: 'Processing failed, please retry' } }; // Paystack retries on non-200
  }
}

/** MOCK mode only: the fake checkout page marks the reference as paid, then (like the real flow) we still verify. */
export async function mockMarkPaid(db: Db, reference: string) {
  if (!config.mockMode) throw new AppError(404, 'NOT_FOUND', 'Mock checkout is disabled');
  const r = await db.query('UPDATE payments SET mock_paid=TRUE WHERE reference=$1', [reference]);
  if (!r.rowCount) throw notFound('Unknown payment reference');
}

export { MOCK_SECRET };
