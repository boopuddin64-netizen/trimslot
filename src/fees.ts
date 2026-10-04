/**
 * Fee model (pure maths, all rates come from admin settings - nothing here is a fixed Paystack number).
 *  - Paystack charges a processing fee on in-app payments. We ESTIMATE it from the rate settings, split it three ways
 *    (customer / barber / platform) and take the customer's share as a "booking fee" on top of the price.
 *  - The platform also has its own charge (percent + flat, with a minimum).
 *  - Barber receives: price - barber's share of the Paystack fee - platform charge.
 *  - Pay on arrival: no Paystack part, no booking fee; only the platform charge (owed through the cash-commission ledger).
 * All amounts are integer kobo.
 */
export interface FeeSettings {
  ps_percent: number; ps_flat_kobo: number; ps_flat_waived_below_kobo: number; ps_cap_kobo: number; ps_vat_percent: number;
  fee_share_customer_pct: number; fee_share_barber_pct: number; fee_share_platform_pct: number;
  charge_percent: number; charge_flat_kobo: number; charge_min_kobo: number;
}
export interface ChargeOverride { fee_percent_override?: number | string | null; fee_flat_kobo_override?: number | null }

/** The processing fee for a payment of `amountKobo`: percent + flat (flat waived below a threshold), capped, then VAT on the fee. */
export function processorFeeKobo(amountKobo: number, s: Pick<FeeSettings, 'ps_percent' | 'ps_flat_kobo' | 'ps_flat_waived_below_kobo' | 'ps_cap_kobo' | 'ps_vat_percent'>): number {
  if (amountKobo <= 0) return 0;
  const base = (amountKobo * Number(s.ps_percent)) / 100 + (amountKobo >= s.ps_flat_waived_below_kobo ? s.ps_flat_kobo : 0);
  const capped = Math.min(base, s.ps_cap_kobo);
  return Math.max(0, Math.round(capped * (1 + Number(s.ps_vat_percent) / 100)));
}

/** The platform's own charge on a booking of this price. A per-barber override (even 0) replaces the settings (and then has no minimum). Never more than the price. */
export function platformChargeKobo(priceKobo: number, s: Pick<FeeSettings, 'charge_percent' | 'charge_flat_kobo' | 'charge_min_kobo'>, o?: ChargeOverride | null): number {
  const hasOverride = !!o && (o.fee_percent_override != null || o.fee_flat_kobo_override != null);
  const raw = hasOverride
    ? Math.round((priceKobo * Number(o!.fee_percent_override ?? 0)) / 100) + (o!.fee_flat_kobo_override ?? 0)
    : Math.max(s.charge_min_kobo, Math.round((priceKobo * Number(s.charge_percent)) / 100) + s.charge_flat_kobo);
  return Math.max(0, Math.min(raw, priceKobo));
}

export interface FeeBreakdown {
  price_kobo: number;
  /** Customer pays price + booking fee. */
  booking_fee_kobo: number; total_kobo: number;
  /** Estimated Paystack fee on `total_kobo` and how it is shared. */
  ps_fee_kobo: number; barber_fee_kobo: number; platform_share_kobo: number;
  platform_charge_kobo: number;
  /** What the barber receives: price - barber_fee - platform_charge (never below 0). */
  payout_kobo: number;
  /** What the platform keeps after Paystack takes its fee: charge + (customer + barber shares) - ps_fee  =  charge - platform_share. */
  platform_net_kobo: number;
}

/** Pay-now breakdown. The fee depends on the total and the total includes the customer's share, so we solve that small loop (it settles in 2-3 steps). */
export function onlineBreakdown(priceKobo: number, s: FeeSettings, o?: ChargeOverride | null): FeeBreakdown {
  const cs = Number(s.fee_share_customer_pct) / 100, bs = Number(s.fee_share_barber_pct) / 100;
  let total = priceKobo, fee = processorFeeKobo(total, s), c = Math.round(fee * cs);
  for (let i = 0; i < 8; i++) {
    const next = priceKobo + c;
    if (next === total) break;
    total = next; fee = processorFeeKobo(total, s); c = Math.round(fee * cs);
  }
  total = priceKobo + c; fee = processorFeeKobo(total, s);
  const bookingFee = Math.min(c, fee);
  const b = Math.min(Math.round(fee * bs), fee - bookingFee);
  const p = fee - bookingFee - b;
  const charge = Math.min(platformChargeKobo(priceKobo, s, o), Math.max(0, priceKobo - b));
  return {
    price_kobo: priceKobo, booking_fee_kobo: bookingFee, total_kobo: priceKobo + bookingFee,
    ps_fee_kobo: fee, barber_fee_kobo: b, platform_share_kobo: p, platform_charge_kobo: charge,
    payout_kobo: Math.max(0, priceKobo - b - charge), platform_net_kobo: bookingFee + b + charge - fee,
  };
}

/** Pay-on-arrival / plan session / credit: no payment through Paystack. Pay-on-arrival still carries the platform charge (owed via the ledger). */
export function offAppBreakdown(priceKobo: number, s: FeeSettings, o?: ChargeOverride | null): FeeBreakdown {
  return { price_kobo: priceKobo, booking_fee_kobo: 0, total_kobo: priceKobo, ps_fee_kobo: 0, barber_fee_kobo: 0, platform_share_kobo: 0,
    platform_charge_kobo: platformChargeKobo(priceKobo, s, o), payout_kobo: priceKobo, platform_net_kobo: 0 };
}

export const feeSettingsOf = (s: FeeSettings): FeeSettings => ({
  ps_percent: Number(s.ps_percent), ps_flat_kobo: s.ps_flat_kobo, ps_flat_waived_below_kobo: s.ps_flat_waived_below_kobo, ps_cap_kobo: s.ps_cap_kobo, ps_vat_percent: Number(s.ps_vat_percent),
  fee_share_customer_pct: Number(s.fee_share_customer_pct), fee_share_barber_pct: Number(s.fee_share_barber_pct), fee_share_platform_pct: Number(s.fee_share_platform_pct),
  charge_percent: Number(s.charge_percent), charge_flat_kobo: s.charge_flat_kobo, charge_min_kobo: s.charge_min_kobo,
});
