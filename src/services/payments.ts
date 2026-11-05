import crypto from 'node:crypto';
import { config, razorpayEnabled } from '../config.js';
import type { Booking } from '../types.js';
import { hmac, safeEqual } from '../utils/misc.js';
import { getSetting } from './settings.js';

export const amountDue = (b: Pick<Booking, 'status' | 'amount_required' | 'amount_paid' | 'total_amount'>) =>
  Math.max(0, (b.status === 'pending_payment' || b.status === 'expired' ? b.amount_required : b.total_amount) - b.amount_paid);

/** upi://pay deep link understood by GPay, PhonePe, Paytm, BHIM… */
export function upiLink(b: Pick<Booking, 'code'>, amount: number): string | null {
  const vpa = getSetting('upi_vpa').trim();
  if (!vpa) return null;
  const params = new URLSearchParams({
    pa: vpa,
    pn: getSetting('upi_payee_name') || getSetting('business_name'),
    am: amount.toFixed(2),
    cu: 'INR',
    tn: `Turf booking ${b.code}`,
    tr: b.code,
  });
  return `upi://pay?${params.toString().replace(/\+/g, '%20')}`;
}

/** Signed public URL of the payment page for a booking (prevents guessing other customers' codes). */
export function paymentPageUrl(code: string): string {
  return `${config.publicBaseUrl}/pay/${code}?t=${paymentToken(code)}`;
}

export const paymentToken = (code: string) => hmac(`pay:${code}`).slice(0, 24);
export const verifyPaymentToken = (code: string, token: string) => safeEqual(paymentToken(code), token);

/* ------------------------------- Razorpay ------------------------------ */

export interface RazorpayLink {
  id: string;
  short_url: string;
}

/**
 * Creates a Razorpay Payment Link (supports UPI, cards, netbanking) for the
 * amount due. Razorpay calls /webhooks/razorpay when it is paid, which
 * confirms the booking automatically.
 */
export async function createRazorpayLink(
  b: Pick<Booking, 'code' | 'contact_name' | 'contact_phone' | 'hold_expires_at'>,
  amount: number,
): Promise<RazorpayLink | null> {
  if (!razorpayEnabled()) return null;
  const auth = Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64');
  const body: Record<string, unknown> = {
    amount: Math.round(amount * 100),
    currency: 'INR',
    accept_partial: false,
    reference_id: `${b.code}-${Date.now().toString(36)}`,
    description: `Turf booking ${b.code}`,
    customer: { name: b.contact_name, contact: `+${b.contact_phone}` },
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes: { booking_code: b.code },
  };
  // Razorpay requires expire_by to be at least 15 minutes in the future
  if (b.hold_expires_at && b.hold_expires_at - Date.now() > 16 * 60_000) body.expire_by = Math.floor(b.hold_expires_at / 1000);
  const res = await fetch('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error('[razorpay] create link failed', res.status, await res.text().catch(() => ''));
    return null;
  }
  const json = (await res.json()) as RazorpayLink;
  return { id: json.id, short_url: json.short_url };
}

export function verifyRazorpaySignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!config.razorpay.webhookSecret || !signature) return false;
  const expected = crypto.createHmac('sha256', config.razorpay.webhookSecret).update(rawBody).digest('hex');
  return safeEqual(expected, signature);
}
