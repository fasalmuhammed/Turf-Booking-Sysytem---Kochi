import type { BookingView } from '../services/bookings.js';
import { getLocation } from '../services/catalog.js';
import { amountDue } from '../services/payments.js';
import { displayPhone, rupees } from '../utils/misc.js';
import { durationLabel, formatDateLong, formatRange } from '../utils/time.js';

export const STATUS_LABEL: Record<string, string> = {
  pending_payment: '⏳ Awaiting payment',
  confirmed: '✅ Confirmed',
  cancelled: '❌ Cancelled',
  expired: '⌛ Expired (not paid)',
  completed: '🏁 Completed',
  no_show: '🚫 No-show',
};

export const PAYMENT_LABEL: Record<string, string> = {
  unpaid: 'Unpaid',
  verification_pending: 'Verifying payment',
  advance_paid: 'Advance paid',
  paid: 'Fully paid',
  refund_pending: 'Refund in progress',
  refunded: 'Refunded',
};

export function bookingDetailsText(b: BookingView, opts: { title?: string; showStatus?: boolean } = {}): string {
  const lines: string[] = [];
  if (opts.title) lines.push(opts.title, '');
  lines.push(`🆔 *Booking ID:* ${b.code}`);
  lines.push(`🏟️ *Turf:* ${b.turf_name} (${b.location_name})`);
  lines.push(`📅 *Date:* ${formatDateLong(b.date)}`);
  lines.push(`⏰ *Time:* ${formatRange(b.start_minute, b.end_minute)} (${durationLabel(b.end_minute - b.start_minute)})`);
  lines.push(`👤 *Name:* ${b.contact_name}`);
  lines.push(`📱 *Mobile:* ${displayPhone(b.contact_phone)}`);
  if (b.discount_amount > 0) {
    lines.push(`💰 *Price:* ~${rupees(b.gross_amount)}~ ${rupees(b.total_amount)} (${b.offer_title})`);
  } else {
    lines.push(`💰 *Price:* ${rupees(b.total_amount)}`);
  }
  if (opts.showStatus !== false) {
    lines.push(`📌 *Status:* ${STATUS_LABEL[b.status] ?? b.status}`);
    if (b.amount_paid > 0 || b.status === 'confirmed') {
      lines.push(`💳 *Paid:* ${rupees(b.amount_paid)} · ${PAYMENT_LABEL[b.payment_status] ?? b.payment_status}`);
      const balance = b.total_amount - b.amount_paid;
      if (balance > 0 && b.status === 'confirmed') lines.push(`🧾 *Balance at venue:* ${rupees(balance)}`);
    } else if (b.status === 'pending_payment') {
      lines.push(`💳 *To pay now:* ${rupees(amountDue(b))}${b.payment_option === 'advance' ? ' (advance)' : ''}`);
    }
    if (b.status === 'cancelled' && b.refund_amount > 0) {
      lines.push(`↩️ *Refund:* ${rupees(b.refund_amount)} · ${PAYMENT_LABEL[b.payment_status]}`);
    }
  }
  return lines.join('\n');
}

export function locationLine(locationId: number): string {
  const loc = getLocation(locationId);
  if (!loc) return '';
  const parts = [`📍 *${loc.name}*`];
  if (loc.address) parts.push(loc.address);
  if (loc.maps_url) parts.push(`🗺️ ${loc.maps_url}`);
  if (loc.contact_phone) parts.push(`📞 ${loc.contact_phone}`);
  return parts.join('\n');
}
