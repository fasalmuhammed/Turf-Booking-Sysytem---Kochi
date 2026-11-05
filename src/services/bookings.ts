import { all, get, run, tx } from '../db/index.js';
import type { Booking, BookingStatus, Payment, PaymentStatus } from '../types.js';
import { randomCode } from '../utils/misc.js';
import { addDays, today, toEpoch } from '../utils/time.js';
import { isRangeBookable, isWithinBookingWindow } from './availability.js';
import { getTurf } from './catalog.js';
import { quote } from './pricing.js';
import { getNumber } from './settings.js';

export class BookingError extends Error {
  constructor(
    message: string,
    public code: 'unavailable' | 'invalid' | 'not_allowed' | 'not_found',
  ) {
    super(message);
  }
}

export interface BookingView extends Booking {
  turf_name: string;
  location_name: string;
  location_id: number;
  customer_phone: string;
  slot_minutes: number;
}

const VIEW_SELECT = `
  SELECT b.*, t.name AS turf_name, t.slot_minutes, l.name AS location_name, l.id AS location_id, c.phone AS customer_phone
    FROM bookings b
    JOIN turfs t ON t.id = b.turf_id
    JOIN locations l ON l.id = t.location_id
    JOIN customers c ON c.id = b.customer_id`;

export const getBooking = (id: number) => get<BookingView>(`${VIEW_SELECT} WHERE b.id = ?`, id);
export const getBookingByCode = (code: string) => get<BookingView>(`${VIEW_SELECT} WHERE b.code = ?`, code.trim().toUpperCase());

function newCode(): string {
  for (let i = 0; i < 20; i++) {
    const code = `TB${randomCode(6)}`;
    if (!get('SELECT 1 FROM bookings WHERE code = ?', code)) return code;
  }
  throw new Error('Could not generate a unique booking code');
}

export const bookingStartMs = (b: Pick<Booking, 'date' | 'start_minute'>) => toEpoch(b.date, b.start_minute);
export const bookingEndMs = (b: Pick<Booking, 'date' | 'end_minute'>) => toEpoch(b.date, b.end_minute);

function derivePaymentStatus(b: Pick<Booking, 'amount_paid' | 'total_amount' | 'amount_required'>, hasPendingClaim: boolean): PaymentStatus {
  if (b.amount_paid >= b.total_amount) return 'paid';
  if (b.amount_paid > 0 && b.amount_paid >= b.amount_required) return 'advance_paid';
  return hasPendingClaim ? 'verification_pending' : 'unpaid';
}

const hasPendingClaim = (bookingId: number) =>
  Boolean(get("SELECT 1 FROM payments WHERE booking_id = ? AND status = 'pending'", bookingId));

/* ------------------------------- Creation ------------------------------ */

export interface CreateBookingInput {
  turfId: number;
  customerId: number;
  date: string;
  startMinute: number;
  slots: number;
  contactName: string;
  contactPhone: string;
  paymentOption: 'advance' | 'full';
  source?: 'whatsapp' | 'admin';
  /** admin only: confirm immediately (pay at venue) */
  confirmNow?: boolean;
  notes?: string;
  nowMs?: number;
}

/**
 * Atomically checks availability and inserts the booking. Runs inside a
 * BEGIN IMMEDIATE transaction so two customers can never take the same slot.
 */
export function createBooking(input: CreateBookingInput): BookingView {
  const nowMs = input.nowMs ?? Date.now();
  const source = input.source ?? 'whatsapp';
  const id = tx(() => {
    const turf = getTurf(input.turfId);
    if (!turf || !turf.active || !turf.location_active) throw new BookingError('This turf is not available for booking.', 'invalid');
    if (!Number.isInteger(input.slots) || input.slots < 1 || input.slots > (source === 'admin' ? 12 : turf.max_slots_per_booking)) {
      throw new BookingError('Invalid number of slots.', 'invalid');
    }
    if (source === 'whatsapp' && !isWithinBookingWindow(input.date, nowMs)) {
      throw new BookingError('That date is outside the booking window.', 'invalid');
    }
    if (source === 'whatsapp') {
      const holds = get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM bookings WHERE customer_id = ? AND status = 'pending_payment' AND (hold_expires_at IS NULL OR hold_expires_at > ?)",
        input.customerId,
        nowMs,
      )!.n;
      if (holds >= MAX_OPEN_HOLDS) {
        throw new BookingError('You already have unpaid bookings on hold. Please pay for or cancel them before booking another slot.', 'not_allowed');
      }
    }
    const end = input.startMinute + input.slots * turf.slot_minutes;
    const check = isRangeBookable(turf, input.date, input.startMinute, end, { nowMs, ignoreLeadTime: source === 'admin' });
    if (!check.ok) throw new BookingError(check.reason, 'unavailable');

    const q = quote(turf, input.date, input.startMinute, input.slots);
    const option = input.paymentOption === 'advance' && q.advanceAllowed ? 'advance' : 'full';
    const required = option === 'advance' ? q.advance : q.total;
    const confirmed = Boolean(input.confirmNow) || required === 0;
    const holdMs = getNumber('hold_minutes') * 60_000;

    return run(
      `INSERT INTO bookings (code, turf_id, customer_id, date, start_minute, end_minute, contact_name, contact_phone,
                             gross_amount, discount_amount, total_amount, offer_title, payment_option, amount_required,
                             amount_paid, status, payment_status, hold_expires_at, source, notes, created_at, updated_at, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'unpaid', ?, ?, ?, ?, ?, ?)`,
      newCode(),
      turf.id,
      input.customerId,
      input.date,
      input.startMinute,
      end,
      input.contactName,
      input.contactPhone,
      q.gross,
      q.discount,
      q.total,
      q.offer?.title ?? '',
      option,
      required,
      confirmed ? 'confirmed' : 'pending_payment',
      confirmed ? null : nowMs + holdMs,
      source,
      input.notes ?? '',
      nowMs,
      nowMs,
      confirmed ? nowMs : null,
    ).lastId;
  });
  return getBooking(id)!;
}

export const MAX_OPEN_HOLDS = 2;

/** Puts an expired (unpaid) booking back on hold if its slot is still free. */
export function reviveHold(bookingId: number, nowMs = Date.now()): BookingView | null {
  return tx(() => {
    const b = getBooking(bookingId);
    if (!b) return null;
    if (b.status === 'pending_payment') return b;
    if (b.status !== 'expired') return null;
    const ok = isRangeBookable(getTurf(b.turf_id)!, b.date, b.start_minute, b.end_minute, { nowMs, excludeBookingId: b.id });
    if (!ok.ok) return null;
    run(
      "UPDATE bookings SET status = 'pending_payment', hold_expires_at = ?, updated_at = ? WHERE id = ?",
      nowMs + getNumber('hold_minutes') * 60_000,
      nowMs,
      b.id,
    );
    return getBooking(b.id)!;
  });
}

/* ------------------------------- Payments ------------------------------ */

export interface PaymentResult {
  booking: BookingView;
  confirmedNow: boolean;
  /** payment arrived but the slot was lost meanwhile → refund needed */
  conflict: boolean;
}

/**
 * Records a successful payment (verified UPI claim, Razorpay webhook, cash…)
 * and confirms the booking once the required amount is covered.
 */
export function recordPayment(
  bookingId: number,
  p: { amount: number; method: string; reference?: string; providerId?: string; verifiedBy?: number | null; claimId?: number; note?: string },
  nowMs = Date.now(),
): PaymentResult {
  return tx(() => {
    const b = getBooking(bookingId);
    if (!b) throw new BookingError('Booking not found', 'not_found');
    if (p.amount <= 0) throw new BookingError('Amount must be positive', 'invalid');
    if (p.providerId && get("SELECT 1 FROM payments WHERE provider_id = ? AND status = 'success'", p.providerId)) {
      return { booking: b, confirmedNow: false, conflict: false }; // duplicate webhook
    }

    if (p.claimId) {
      run(
        `UPDATE payments SET status = 'success', amount = ?, method = ?, reference = COALESCE(NULLIF(?, ''), reference),
                verified_at = ?, verified_by = ?, note = ? WHERE id = ? AND booking_id = ?`,
        p.amount,
        p.method,
        p.reference ?? '',
        nowMs,
        p.verifiedBy ?? null,
        p.note ?? '',
        p.claimId,
        bookingId,
      );
    } else {
      run(
        `INSERT INTO payments (booking_id, amount, method, reference, status, provider_id, note, created_at, verified_at, verified_by)
         VALUES (?, ?, ?, ?, 'success', ?, ?, ?, ?, ?)`,
        bookingId,
        p.amount,
        p.method,
        p.reference ?? '',
        p.providerId ?? '',
        p.note ?? '',
        nowMs,
        nowMs,
        p.verifiedBy ?? null,
      );
    }

    const paid = b.amount_paid + p.amount;
    let status: BookingStatus = b.status;
    let confirmedNow = false;
    let conflict = false;
    let refund = b.refund_amount;

    if ((b.status === 'pending_payment' || b.status === 'expired') && paid >= b.amount_required) {
      const holdLapsed = b.status === 'expired' || (b.hold_expires_at !== null && b.hold_expires_at <= nowMs);
      const stillFree =
        !holdLapsed ||
        isRangeBookable(getTurf(b.turf_id)!, b.date, b.start_minute, b.end_minute, {
          nowMs,
          excludeBookingId: b.id,
          ignoreLeadTime: true,
        }).ok;
      if (stillFree) {
        status = 'confirmed';
        confirmedNow = true;
      } else {
        status = 'cancelled';
        conflict = true;
        refund = paid;
      }
    }

    if (b.status === 'cancelled') refund = b.refund_amount + p.amount; // money received for an already-cancelled booking
    let paymentStatus = derivePaymentStatus({ ...b, amount_paid: paid }, hasPendingClaim(b.id));
    if (conflict || (b.status === 'cancelled' && refund > 0)) paymentStatus = 'refund_pending';

    run(
      `UPDATE bookings SET amount_paid = ?, status = ?, payment_status = ?, hold_expires_at = ?, refund_amount = ?,
              cancel_reason = CASE WHEN ? THEN 'Slot was taken before payment completed' ELSE cancel_reason END,
              cancelled_at = CASE WHEN ? THEN ? ELSE cancelled_at END,
              confirmed_at = CASE WHEN ? THEN ? ELSE confirmed_at END, updated_at = ?
        WHERE id = ?`,
      paid,
      status,
      paymentStatus,
      status === 'pending_payment' ? b.hold_expires_at : null,
      refund,
      conflict,
      conflict,
      nowMs,
      confirmedNow,
      nowMs,
      nowMs,
      b.id,
    );
    return { booking: getBooking(b.id)!, confirmedNow, conflict };
  });
}

/** Customer says "I've paid" and shares the UPI reference (UTR). Holds the slot while an admin verifies. */
export function submitPaymentClaim(bookingId: number, reference: string, nowMs = Date.now()): BookingView {
  return tx(() => {
    const b = getBooking(bookingId);
    if (!b) throw new BookingError('Booking not found', 'not_found');
    if (b.status === 'expired') {
      const turf = getTurf(b.turf_id)!;
      const ok = isRangeBookable(turf, b.date, b.start_minute, b.end_minute, { nowMs, excludeBookingId: b.id }).ok;
      if (!ok) throw new BookingError('Sorry, your hold expired and the slot was taken. If you already paid, our team will refund you.', 'unavailable');
      run("UPDATE bookings SET status = 'pending_payment' WHERE id = ?", b.id);
    } else if (b.status !== 'pending_payment' && b.status !== 'confirmed') {
      throw new BookingError('This booking can no longer accept payments.', 'not_allowed');
    }
    const due = Math.max(0, (b.status === 'confirmed' ? b.total_amount : b.amount_required) - b.amount_paid);
    run(
      `INSERT INTO payments (booking_id, amount, method, reference, status, created_at) VALUES (?, ?, 'upi_manual', ?, 'pending', ?)`,
      b.id,
      due,
      reference.slice(0, 64),
      nowMs,
    );
    run(
      `UPDATE bookings SET payment_status = CASE WHEN status = 'pending_payment' THEN 'verification_pending' ELSE payment_status END,
              hold_expires_at = NULL, updated_at = ? WHERE id = ?`,
      nowMs,
      b.id,
    );
    return getBooking(b.id)!;
  });
}

export function rejectPaymentClaim(paymentId: number, adminId: number, note: string, nowMs = Date.now()): BookingView {
  return tx(() => {
    const p = get<Payment>('SELECT * FROM payments WHERE id = ?', paymentId);
    if (!p || p.status !== 'pending') throw new BookingError('Payment claim not found', 'not_found');
    run("UPDATE payments SET status = 'failed', verified_at = ?, verified_by = ?, note = ? WHERE id = ?", nowMs, adminId, note, paymentId);
    const b = getBooking(p.booking_id)!;
    const ps = derivePaymentStatus(b, hasPendingClaim(b.id));
    const hold = b.status === 'pending_payment' && !hasPendingClaim(b.id) ? nowMs + getNumber('hold_minutes') * 60_000 : b.hold_expires_at;
    run('UPDATE bookings SET payment_status = ?, hold_expires_at = ?, updated_at = ? WHERE id = ?', ps, hold, nowMs, b.id);
    return getBooking(b.id)!;
  });
}

export function markRefunded(bookingId: number, adminId: number, reference: string, nowMs = Date.now()) {
  return tx(() => {
    const b = getBooking(bookingId);
    if (!b || b.payment_status !== 'refund_pending') throw new BookingError('No refund pending for this booking', 'not_allowed');
    run(
      `INSERT INTO payments (booking_id, amount, method, reference, status, created_at, verified_at, verified_by)
       VALUES (?, ?, 'refund', ?, 'refunded', ?, ?, ?)`,
      b.id,
      b.refund_amount,
      reference,
      nowMs,
      nowMs,
      adminId,
    );
    run("UPDATE bookings SET payment_status = 'refunded', updated_at = ? WHERE id = ?", nowMs, b.id);
    return getBooking(b.id)!;
  });
}

export const listPaymentsForBooking = (bookingId: number) =>
  all<Payment>('SELECT * FROM payments WHERE booking_id = ? ORDER BY id', bookingId);

export const pendingClaims = () =>
  all<Payment & { code: string; contact_name: string; turf_name: string; date: string; start_minute: number; end_minute: number }>(
    `SELECT p.*, b.code, b.contact_name, t.name AS turf_name, b.date, b.start_minute, b.end_minute
       FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN turfs t ON t.id = b.turf_id
      WHERE p.status = 'pending' ORDER BY p.created_at`,
  );

/* ---------------------------- Cancellations ---------------------------- */

export type PolicyCheck = { allowed: true; refund: number; note: string } | { allowed: false; reason: string };

export function cancellationQuote(b: Booking, by: 'customer' | 'admin', nowMs = Date.now()): PolicyCheck {
  if (b.status !== 'pending_payment' && b.status !== 'confirmed') {
    return { allowed: false, reason: `This booking is already ${b.status.replace('_', ' ')}.` };
  }
  if (by === 'admin') return { allowed: true, refund: b.amount_paid, note: 'Admin cancellation' };
  const hoursLeft = (bookingStartMs(b) - nowMs) / 3_600_000;
  const cutoff = getNumber('cancel_cutoff_hours');
  if (hoursLeft < cutoff) {
    return { allowed: false, reason: `Cancellations are not allowed within ${cutoff} hour${cutoff === 1 ? '' : 's'} of the slot.` };
  }
  if (b.amount_paid === 0) return { allowed: true, refund: 0, note: 'No payment was made, so nothing to refund.' };
  const freeHours = getNumber('free_cancel_hours');
  if (hoursLeft >= freeHours) return { allowed: true, refund: b.amount_paid, note: `Full refund (cancelled ${freeHours}+ hours before).` };
  const pct = Math.max(0, Math.min(100, getNumber('late_cancel_refund_percent')));
  return {
    allowed: true,
    refund: Math.floor((b.amount_paid * pct) / 100),
    note: `${pct}% refund (cancelled less than ${freeHours} hours before).`,
  };
}

export function cancelBooking(
  bookingId: number,
  opts: { by: 'customer' | 'admin'; reason?: string; refundOverride?: number },
  nowMs = Date.now(),
): BookingView {
  return tx(() => {
    const b = getBooking(bookingId);
    if (!b) throw new BookingError('Booking not found', 'not_found');
    const check = cancellationQuote(b, opts.by, nowMs);
    if (!check.allowed) throw new BookingError(check.reason, 'not_allowed');
    const refund = Math.max(0, Math.min(b.amount_paid, opts.refundOverride ?? check.refund));
    run(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, refund_amount = ?,
              payment_status = CASE WHEN ? > 0 THEN 'refund_pending' ELSE payment_status END,
              hold_expires_at = NULL, updated_at = ?
        WHERE id = ?`,
      nowMs,
      opts.reason ?? (opts.by === 'customer' ? 'Cancelled by customer' : 'Cancelled by admin'),
      refund,
      refund,
      nowMs,
      b.id,
    );
    return getBooking(b.id)!;
  });
}

/* ----------------------------- Rescheduling ---------------------------- */

export function rescheduleCheck(b: Booking, by: 'customer' | 'admin', nowMs = Date.now()): PolicyCheck {
  if (b.status !== 'pending_payment' && b.status !== 'confirmed') {
    return { allowed: false, reason: `This booking is already ${b.status.replace('_', ' ')}.` };
  }
  if (by === 'admin') return { allowed: true, refund: 0, note: '' };
  const max = getNumber('max_reschedules');
  if (b.reschedule_count >= max) {
    return { allowed: false, reason: max === 0 ? 'Rescheduling is not available.' : `This booking has already been rescheduled ${b.reschedule_count} time(s) (limit ${max}).` };
  }
  const cutoff = getNumber('reschedule_cutoff_hours');
  if ((bookingStartMs(b) - nowMs) / 3_600_000 < cutoff) {
    return { allowed: false, reason: `Bookings can only be rescheduled up to ${cutoff} hours before the slot.` };
  }
  return { allowed: true, refund: 0, note: '' };
}

export function rescheduleBooking(
  bookingId: number,
  newDate: string,
  newStart: number,
  by: 'customer' | 'admin',
  nowMs = Date.now(),
): { booking: BookingView; oldDate: string; oldStart: number; priceDelta: number } {
  return tx(() => {
    const b = getBooking(bookingId);
    if (!b) throw new BookingError('Booking not found', 'not_found');
    const check = rescheduleCheck(b, by, nowMs);
    if (!check.allowed) throw new BookingError(check.reason, 'not_allowed');
    const turf = getTurf(b.turf_id)!;
    if (by === 'customer' && !isWithinBookingWindow(newDate, nowMs)) throw new BookingError('That date is outside the booking window.', 'invalid');
    const duration = b.end_minute - b.start_minute;
    const slots = Math.max(1, Math.round(duration / turf.slot_minutes));
    const newEnd = newStart + slots * turf.slot_minutes;
    const ok = isRangeBookable(turf, newDate, newStart, newEnd, { nowMs, excludeBookingId: b.id, ignoreLeadTime: by === 'admin' });
    if (!ok.ok) throw new BookingError(ok.reason, 'unavailable');

    const q = quote(turf, newDate, newStart, slots);
    const required =
      b.status === 'pending_payment' ? (b.payment_option === 'advance' && q.advanceAllowed ? q.advance : q.total) : b.amount_required;
    const next = { amount_paid: b.amount_paid, total_amount: q.total, amount_required: required };
    const ps = b.status === 'confirmed' || b.amount_paid > 0 ? derivePaymentStatus(next, hasPendingClaim(b.id)) : b.payment_status;
    run(
      `UPDATE bookings SET date = ?, start_minute = ?, end_minute = ?, gross_amount = ?, discount_amount = ?, total_amount = ?,
              offer_title = ?, amount_required = ?, payment_status = ?, reschedule_count = reschedule_count + ?,
              reminder_sent_at = NULL, updated_at = ?
        WHERE id = ?`,
      newDate,
      newStart,
      newEnd,
      q.gross,
      q.discount,
      q.total,
      q.offer?.title ?? '',
      required,
      ps,
      by === 'customer' ? 1 : 0,
      nowMs,
      b.id,
    );
    return { booking: getBooking(b.id)!, oldDate: b.date, oldStart: b.start_minute, priceDelta: q.total - b.total_amount };
  });
}

/* ------------------------------ Admin edits ---------------------------- */

export function setBookingStatus(bookingId: number, status: 'completed' | 'no_show' | 'confirmed', nowMs = Date.now()) {
  run(
    `UPDATE bookings SET status = ?, confirmed_at = COALESCE(confirmed_at, ?), hold_expires_at = NULL, updated_at = ? WHERE id = ?`,
    status,
    nowMs,
    nowMs,
    bookingId,
  );
  return getBooking(bookingId)!;
}

/* -------------------------------- Queries ------------------------------ */

export interface BookingFilters {
  status?: string;
  paymentStatus?: string;
  date?: string;
  from?: string;
  to?: string;
  turfId?: number;
  search?: string;
  limit?: number;
}

export function listBookings(f: BookingFilters = {}): BookingView[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.status) {
    if (f.status === 'active') where.push("b.status IN ('pending_payment','confirmed')");
    else {
      where.push('b.status = ?');
      params.push(f.status);
    }
  }
  if (f.paymentStatus) {
    where.push('b.payment_status = ?');
    params.push(f.paymentStatus);
  }
  if (f.date) {
    where.push('b.date = ?');
    params.push(f.date);
  }
  if (f.from) {
    where.push('b.date >= ?');
    params.push(f.from);
  }
  if (f.to) {
    where.push('b.date <= ?');
    params.push(f.to);
  }
  if (f.turfId) {
    where.push('b.turf_id = ?');
    params.push(f.turfId);
  }
  if (f.search?.trim()) {
    const q = `%${f.search.trim()}%`;
    where.push('(b.code LIKE ? OR b.contact_name LIKE ? OR b.contact_phone LIKE ? OR c.phone LIKE ?)');
    params.push(q, q, q, q);
  }
  params.push(f.limit ?? 300);
  return all<BookingView>(
    `${VIEW_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.date DESC, b.start_minute DESC LIMIT ?`,
    ...params,
  );
}

/** Upcoming bookings a customer can still act on. */
export function upcomingForCustomer(customerId: number, nowMs = Date.now()): BookingView[] {
  const from = addDays(today(nowMs), -1);
  return all<BookingView>(
    `${VIEW_SELECT} WHERE b.customer_id = ? AND b.date >= ? AND b.status IN ('pending_payment','confirmed')
      ORDER BY b.date, b.start_minute`,
    customerId,
    from,
  ).filter((b) => bookingEndMs(b) > nowMs);
}

export function recentForCustomer(customerId: number, limit = 20): BookingView[] {
  return all<BookingView>(`${VIEW_SELECT} WHERE b.customer_id = ? ORDER BY b.created_at DESC LIMIT ?`, customerId, limit);
}

/* ---------------------------- Scheduled jobs --------------------------- */

export function expireHolds(nowMs = Date.now()): BookingView[] {
  return tx(() => {
    const rows = all<BookingView>(
      `${VIEW_SELECT} WHERE b.status = 'pending_payment' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at <= ?`,
      nowMs,
    );
    for (const b of rows) run("UPDATE bookings SET status = 'expired', updated_at = ? WHERE id = ?", nowMs, b.id);
    return rows;
  });
}

export function completeFinished(nowMs = Date.now()): number {
  const rows = all<Booking>("SELECT * FROM bookings WHERE status = 'confirmed' AND date <= ?", today(nowMs));
  let n = 0;
  for (const b of rows) {
    if (bookingEndMs(b) <= nowMs) {
      run("UPDATE bookings SET status = 'completed', updated_at = ? WHERE id = ?", nowMs, b.id);
      n++;
    }
  }
  return n;
}

export function dueReminders(nowMs = Date.now()): BookingView[] {
  const windowMs = getNumber('reminder_hours_before') * 3_600_000;
  if (windowMs <= 0) return [];
  const t = today(nowMs);
  return all<BookingView>(
    `${VIEW_SELECT} WHERE b.status = 'confirmed' AND b.reminder_sent_at IS NULL AND b.date BETWEEN ? AND ?`,
    addDays(t, -1),
    addDays(t, 2),
  ).filter((b) => {
    const start = bookingStartMs(b);
    return start > nowMs && start - nowMs <= windowMs;
  });
}

export const markReminderSent = (id: number, nowMs = Date.now()) =>
  run('UPDATE bookings SET reminder_sent_at = ? WHERE id = ?', nowMs, id);
