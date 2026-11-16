import { randomBytes } from 'crypto';
import { Request, Response, Router } from 'express';
import QRCode from 'qrcode';
import { buildReceiptPdf } from './receiptPdf';
import { requireRole } from './auth';
import { config, TIMEZONE } from './config';
import { Db } from './db';
import { notFound } from './errors';
import { fmtTime12 } from './helpers';

type Wrap = (fn: (req: Request, res: Response) => any) => any;

/** Display status comes from the live booking/refund record, never from the receipt's original success alone. */
export function receiptStatus(paymentStatus: unknown, refundStatus: unknown) {
  const payment = String(paymentStatus || ''), refund = String(refundStatus || '');
  if (payment === 'REFUNDED' || refund === 'REFUNDED') return 'Refunded';
  if (payment === 'REFUND_DECLINED' || refund === 'REJECTED') return 'Refund declined';
  if (payment === 'REFUND_PENDING' || refund === 'PENDING_APPROVAL') return 'Refund pending review';
  if (refund === 'NEEDS_REFUND' || refund === 'REFUND_REQUESTED') return 'Refund processing';
  if (payment === 'CREDITED') return 'Session credit issued';
  if (payment === 'CREDIT_PENDING') return 'Session credit pending review';
  return payment === 'PAID' ? 'Paid' : 'Payment received';
}

/** Human-facing serial only; never accepted by a lookup/authorization route. The QR token is separate. */
export function receiptNumber(type: 'BOOKING' | 'PLAN', paymentId: number, paidAt: string) {
  const year = new Intl.DateTimeFormat('en', { timeZone: TIMEZONE, year: 'numeric' }).format(new Date(paidAt));
  return `TS-${type === 'PLAN' ? 'PLAN' : 'BKG'}-${year}-${String(paymentId).padStart(6, '0')}`;
}

export function receiptProviderLabel(provider: unknown): string | null {
  if (provider === 'PAYSTACK') return 'Paystack';
  if (provider === 'MOCK') return 'Test payment (mock)';
  return null;
}

/** Customer-owned receipt rows. The confirmed payment timestamp is preferred over payment-attempt creation time. */
export async function customerReceiptRows(db: Db, customerId: number, paymentId?: number) {
  const rows = await db.many<any>(`SELECT * FROM (
    SELECT 'BOOKING'::text AS receipt_type, p.id AS payment_id, k.id AS booking_id, NULL::integer AS plan_purchase_id,
      k.date::text AS appointment_date, k.start_min, k.service_name AS item_name, NULL::integer AS sessions_total,
      NULL::integer AS validity_days, NULL::timestamptz AS expires_at, b.shop_name, b.location AS barber_location,
      bu.name AS barber_name, cu.name AS customer_name, cu.email AS customer_email, cu.phone AS customer_phone,
      p.reference, p.provider, p.amount_kobo, p.refund_status, k.payment_status,
      COALESCE(p.verified_at, k.paid_at, p.created_at) AS paid_at
    FROM payments p JOIN bookings k ON k.id=p.booking_id
      JOIN barbers b ON b.id=k.barber_id JOIN users bu ON bu.id=b.user_id JOIN users cu ON cu.id=k.customer_id
    WHERE k.customer_id=$1 AND p.status='SUCCESS' AND COALESCE(p.refund_reason,'') NOT LIKE 'Duplicate payment%'
    UNION ALL
    SELECT 'PLAN'::text AS receipt_type, p.id AS payment_id, NULL::integer AS booking_id, pp.id AS plan_purchase_id,
      NULL::text AS appointment_date, NULL::integer AS start_min, pp.plan_name AS item_name, pp.sessions_total,
      pp.validity_days, pp.expires_at, b.shop_name, b.location AS barber_location,
      bu.name AS barber_name, cu.name AS customer_name, cu.email AS customer_email, cu.phone AS customer_phone,
      p.reference, p.provider, p.amount_kobo, p.refund_status, 'PAID'::text AS payment_status,
      COALESCE(p.verified_at, pp.paid_at, p.created_at) AS paid_at
    FROM payments p JOIN plan_purchases pp ON pp.id=p.plan_purchase_id
      JOIN barbers b ON b.id=pp.barber_id JOIN users bu ON bu.id=b.user_id JOIN users cu ON cu.id=pp.customer_id
    WHERE pp.customer_id=$1 AND p.status='SUCCESS' AND COALESCE(p.refund_reason,'') NOT LIKE 'Duplicate payment%'
  ) receipts
  WHERE ($2::integer IS NULL OR payment_id=$2)
  ORDER BY paid_at DESC, payment_id DESC LIMIT 100`, [customerId, paymentId ?? null]);

  return rows.map((r: any) => {
    const type = r.receipt_type as 'BOOKING' | 'PLAN';
    const paidAt = String(r.paid_at);
    return {
      type,
      payment_id: Number(r.payment_id),
      receipt_number: receiptNumber(type, Number(r.payment_id), paidAt),
      booking_id: r.booking_id == null ? null : Number(r.booking_id),
      plan_purchase_id: r.plan_purchase_id == null ? null : Number(r.plan_purchase_id),
      barber: r.barber_name || r.shop_name || 'Barber',
      shop: r.shop_name,
      customer_name: r.customer_name,
      customer_email: r.customer_email,
      customer_phone: r.customer_phone,
      location: r.barber_location,
      item: r.item_name,
      service: type === 'BOOKING' ? r.item_name : null,
      appointment_date: r.appointment_date,
      appointment_time: r.start_min == null ? null : fmtTime12(Number(r.start_min)),
      sessions_total: r.sessions_total == null ? null : Number(r.sessions_total),
      validity_days: r.validity_days == null ? null : Number(r.validity_days),
      expires_at: r.expires_at,
      amount_kobo: Number(r.amount_kobo),
      status: receiptStatus(r.payment_status, r.refund_status),
      payment_provider: receiptProviderLabel(r.provider),
      reference: r.reference,
      paid_at: paidAt,
    };
  });
}

async function tokenForPayment(db: Db, paymentId: number): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const existing = await db.maybeOne<{ token: string }>(`SELECT token FROM receipt_verification_tokens WHERE payment_id=$1 AND revoked_at IS NULL`, [paymentId]);
    if (existing) return existing.token;
    const candidate = randomBytes(32).toString('base64url');
    try {
      await db.query(`INSERT INTO receipt_verification_tokens (payment_id, token, created_at, revoked_at)
        VALUES ($1,$2,now(),NULL)
        ON CONFLICT (payment_id) DO UPDATE SET token=EXCLUDED.token, created_at=now(), revoked_at=NULL
        WHERE receipt_verification_tokens.revoked_at IS NOT NULL`, [paymentId, candidate]);
    } catch (e: any) {
      if (e?.code === '23505') continue; // vanishingly rare token collision; generate a new independent token
      throw e;
    }
    const issued = await db.maybeOne<{ token: string }>(`SELECT token FROM receipt_verification_tokens WHERE payment_id=$1 AND revoked_at IS NULL`, [paymentId]);
    if (issued) return issued.token;
  }
  throw new Error('Could not issue a receipt verification token');
}

export function registerReceiptVerificationRoutes(api: Router, db: Db, wrap: Wrap, limits: { receiptVerify: any }) {
  const cust = requireRole('customer');
  const ownedReceipt = async (paymentId: number, customerId: number) => {
    const receipt = (await customerReceiptRows(db, customerId, paymentId))[0];
    if (!receipt) throw notFound('We could not find that receipt.');
    return receipt;
  };

  api.get('/me/receipts/:paymentId', cust, wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const paymentId = Number(req.params.paymentId);
    if (!Number.isSafeInteger(paymentId) || paymentId < 1) throw notFound('We could not find that receipt.');
    res.json({ receipt: await ownedReceipt(paymentId, req.user!.id) });
  }));

  api.get('/me/receipts/:paymentId/pdf', cust, wrap(async (req, res) => {
    const paymentId = Number(req.params.paymentId);
    if (!Number.isSafeInteger(paymentId) || paymentId < 1) throw notFound('We could not find that receipt.');
    const receipt = await ownedReceipt(paymentId, req.user!.id);
    const token = await tokenForPayment(db, paymentId);
    const verificationUrl = `${config.appBaseUrl}/#/receipt-verify/${token}`;
    const pdf = await buildReceiptPdf(receipt, verificationUrl);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="TrimSlot-${receipt.receipt_number}.pdf"`);
    res.setHeader('Content-Length', String(pdf.length));
    res.send(pdf);
  }));

  api.get('/me/receipts/:paymentId/verification', cust, wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const paymentId = Number(req.params.paymentId);
    if (!Number.isSafeInteger(paymentId) || paymentId < 1) throw notFound('We could not find that receipt.');
    const receipt = await ownedReceipt(paymentId, req.user!.id);
    const token = await tokenForPayment(db, paymentId);
    const verificationUrl = `${config.appBaseUrl}/#/receipt-verify/${token}`;
    const svg = await QRCode.toString(verificationUrl, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#081a3a', light: '#ffffff' } });
    res.json({
      receipt_number: receipt.receipt_number,
      verification_url: verificationUrl,
      qr_data_url: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    });
  }));

  // A token is a random 256-bit bearer identifier stored separately from the human receipt number.
  // The public response is intentionally allowlisted: it never reveals amount, reference, service/location or customer details.
  api.post('/receipts/verify', limits.receiptVerify, wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return void res.status(404).json({ verified: false });
    const row = await db.maybeOne<any>(`SELECT p.id AS payment_id,
        CASE WHEN p.plan_purchase_id IS NOT NULL THEN 'PLAN'::text ELSE 'BOOKING'::text END AS receipt_type,
        COALESCE(p.verified_at, pp.paid_at, k.paid_at, p.created_at) AS paid_at,
        COALESCE(k.payment_status, 'PAID') AS payment_status, p.refund_status
      FROM receipt_verification_tokens rv JOIN payments p ON p.id=rv.payment_id
      LEFT JOIN bookings k ON k.id=p.booking_id LEFT JOIN plan_purchases pp ON pp.id=p.plan_purchase_id
      WHERE rv.token=$1 AND rv.revoked_at IS NULL AND p.status='SUCCESS'
        AND COALESCE(p.refund_reason,'') NOT LIKE 'Duplicate payment%'`, [token]);
    if (!row) return void res.status(404).json({ verified: false });
    const type = row.receipt_type as 'BOOKING' | 'PLAN';
    const paidAt = String(row.paid_at);
    res.json({
      verified: true,
      receipt_number: receiptNumber(type, Number(row.payment_id), paidAt),
      type,
      status: receiptStatus(row.payment_status, row.refund_status),
      paid_at: paidAt,
    });
  }));
}
