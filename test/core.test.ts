import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeCustomer, makeTurf, resetDb } from './helpers.js';
import { addDays, formatMinute, formatRange, today, toEpoch, weekday } from '../src/utils/time.js';
import { normalizePhone } from '../src/utils/misc.js';
import { addPriceRule, createBlock, createOffer, getTurf } from '../src/services/catalog.js';
import { availableSlots, consecutiveFree, getSlots } from '../src/services/availability.js';
import { quote } from '../src/services/pricing.js';
import {
  BookingError,
  cancelBooking,
  cancellationQuote,
  createBooking,
  dueReminders,
  expireHolds,
  getBooking,
  recordPayment,
  rejectPaymentClaim,
  rescheduleBooking,
  reviveHold,
  submitPaymentClaim,
} from '../src/services/bookings.js';
import { setSettings } from '../src/services/settings.js';
import { get } from '../src/db/index.js';

const tomorrow = () => addDays(today(), 1);

describe('time utilities', () => {
  it('converts local IST times to epoch', () => {
    assert.equal(new Date(toEpoch('2026-11-05', 0)).toISOString(), '2026-11-04T18:30:00.000Z');
    assert.equal(new Date(toEpoch('2026-11-05', 1500)).toISOString(), '2026-11-05T19:30:00.000Z'); // 1:00 AM next day
  });
  it('formats late-night minutes', () => {
    assert.equal(formatMinute(1500), '1:00 AM');
    assert.equal(formatMinute(720), '12:00 PM');
    assert.equal(formatRange(1380, 1440), '11:00 PM – 12:00 AM');
  });
  it('computes weekdays and adds days across months', () => {
    assert.equal(weekday('2026-11-05'), 4);
    assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  });
  it('normalises Indian phone numbers', () => {
    assert.equal(normalizePhone('98765 43210'), '919876543210');
    assert.equal(normalizePhone('+91-98765-43210'), '919876543210');
    assert.equal(normalizePhone('09876543210'), '919876543210');
    assert.equal(normalizePhone('12345'), null);
  });
});

describe('pricing & offers', () => {
  beforeEach(resetDb);

  it('applies time-based price rules and the best offer', () => {
    const { turfId } = makeTurf();
    addPriceRule({ turf_id: turfId, label: 'Peak', days: '', start_minute: 1080, end_minute: 1380, price: 1500 });
    createOffer({ turf_id: null, title: 'Morning', description: '', discount_type: 'percent', discount_value: 20, valid_from: null, valid_to: null, days: '', start_minute: 360, end_minute: 540, min_slots: 1, active: true });
    createOffer({ turf_id: null, title: 'Combo', description: '', discount_type: 'flat', discount_value: 100, valid_from: null, valid_to: null, days: '', start_minute: null, end_minute: null, min_slots: 2, active: true });
    const turf = getTurf(turfId)!;
    const d = tomorrow();

    const peak = quote(turf, d, 1080, 1);
    assert.equal(peak.total, 1500);
    assert.equal(peak.offer, null);

    const morning = quote(turf, d, 360, 1);
    assert.equal(morning.gross, 1000);
    assert.equal(morning.discount, 200);
    assert.equal(morning.offer?.title, 'Morning');
    assert.equal(morning.advance, 240); // 30% of 800

    const combo = quote(turf, d, 600, 2);
    assert.equal(combo.total, 1900);
    assert.equal(combo.offer?.title, 'Combo');
  });
});

describe('availability & double-booking prevention', () => {
  beforeEach(resetDb);

  it('generates slots across midnight', () => {
    const { turfId } = makeTurf({ open_minute: 1200, close_minute: 1560 }); // 8 PM – 2 AM
    const slots = getSlots(getTurf(turfId)!, tomorrow());
    assert.deepEqual(slots.map((s) => formatMinute(s.start)), ['8:00 PM', '9:00 PM', '10:00 PM', '11:00 PM', '12:00 AM', '1:00 AM']);
  });

  it('never allows two bookings for the same slot', () => {
    const { turfId } = makeTurf();
    const a = makeCustomer('919811111111');
    const b = makeCustomer('919822222222');
    const d = tomorrow();
    const base = { turfId, date: d, startMinute: 1080, slots: 1, contactName: 'A', contactPhone: a.phone, paymentOption: 'full' as const };
    createBooking({ ...base, customerId: a.id });
    assert.throws(() => createBooking({ ...base, customerId: b.id, contactName: 'B' }), (e: unknown) => e instanceof BookingError && e.code === 'unavailable');
    // overlapping multi-slot booking is rejected too
    assert.throws(() => createBooking({ ...base, startMinute: 1020, slots: 2, customerId: b.id }), BookingError);
    // adjacent booking is fine
    assert.doesNotThrow(() => createBooking({ ...base, startMinute: 1140, customerId: b.id }));
  });

  it('respects admin blocks and closed days', () => {
    const d = tomorrow();
    const { turfId } = makeTurf({ closed_days: String((weekday(d) + 1) % 7) });
    createBlock({ turf_id: turfId, date: d, start_minute: 600, end_minute: 720, reason: 'Maintenance', created_by: null });
    const turf = getTurf(turfId)!;
    const free = availableSlots(turf, d).map((s) => s.start);
    assert.ok(!free.includes(600) && !free.includes(660));
    assert.ok(free.includes(720));
    assert.equal(availableSlots(turf, addDays(d, 1)).length, 0, 'closed day has no slots');
    assert.equal(consecutiveFree(turf, d, 480, 3), 2, 'run stops at the block');
  });

  it('frees a slot when an unpaid hold expires, and can revive it', () => {
    const { turfId } = makeTurf();
    const c = makeCustomer();
    const d = tomorrow();
    const now = Date.now();
    const bk = createBooking({ turfId, customerId: c.id, date: d, startMinute: 900, slots: 1, contactName: 'R', contactPhone: c.phone, paymentOption: 'full', nowMs: now });
    assert.ok(!availableSlots(getTurf(turfId)!, d, now).some((s) => s.start === 900));
    const later = now + 16 * 60_000;
    assert.ok(availableSlots(getTurf(turfId)!, d, later).some((s) => s.start === 900), 'expired hold no longer blocks');
    assert.equal(expireHolds(later).length, 1);
    assert.equal(getBooking(bk.id)!.status, 'expired');
    assert.equal(reviveHold(bk.id, later)!.status, 'pending_payment');
  });
});

describe('payments', () => {
  beforeEach(resetDb);

  it('confirms after an advance payment and tracks the balance', () => {
    const { turfId } = makeTurf();
    const c = makeCustomer();
    const bk = createBooking({ turfId, customerId: c.id, date: tomorrow(), startMinute: 900, slots: 2, contactName: 'R', contactPhone: c.phone, paymentOption: 'advance' });
    assert.equal(bk.amount_required, 600);
    const claimed = submitPaymentClaim(bk.id, '412345678901');
    assert.equal(claimed.payment_status, 'verification_pending');
    assert.equal(claimed.hold_expires_at, null, 'slot is held while verifying');
    const claim = get<{ id: number }>("SELECT id FROM payments WHERE booking_id = ? AND status = 'pending'", bk.id)!;
    const r = recordPayment(bk.id, { amount: 600, method: 'upi', claimId: claim.id, verifiedBy: 1 });
    assert.equal(r.confirmedNow, true);
    assert.equal(r.booking.status, 'confirmed');
    assert.equal(r.booking.payment_status, 'advance_paid');
    const full = recordPayment(bk.id, { amount: 1400, method: 'cash' });
    assert.equal(full.booking.payment_status, 'paid');
  });

  it('rejecting a claim re-opens a short hold', () => {
    const { turfId } = makeTurf();
    const c = makeCustomer();
    const bk = createBooking({ turfId, customerId: c.id, date: tomorrow(), startMinute: 900, slots: 1, contactName: 'R', contactPhone: c.phone, paymentOption: 'full' });
    submitPaymentClaim(bk.id, 'ABC123456');
    const claim = get<{ id: number }>("SELECT id FROM payments WHERE booking_id = ?", bk.id)!;
    const b = rejectPaymentClaim(claim.id, 1, 'not received');
    assert.equal(b.payment_status, 'unpaid');
    assert.ok(b.hold_expires_at && b.hold_expires_at > Date.now());
  });

  it('flags a refund when payment arrives after the slot was taken', () => {
    const { turfId } = makeTurf();
    const a = makeCustomer('919811111111');
    const b = makeCustomer('919822222222');
    const d = tomorrow();
    const now = Date.now();
    const first = createBooking({ turfId, customerId: a.id, date: d, startMinute: 900, slots: 1, contactName: 'A', contactPhone: a.phone, paymentOption: 'full', nowMs: now });
    const later = now + 20 * 60_000;
    expireHolds(later);
    createBooking({ turfId, customerId: b.id, date: d, startMinute: 900, slots: 1, contactName: 'B', contactPhone: b.phone, paymentOption: 'full', nowMs: later });
    const r = recordPayment(first.id, { amount: 1000, method: 'razorpay', providerId: 'pay_1' }, later + 1000);
    assert.equal(r.conflict, true);
    assert.equal(r.booking.status, 'cancelled');
    assert.equal(r.booking.payment_status, 'refund_pending');
    assert.equal(r.booking.refund_amount, 1000);
    // duplicate webhook delivery is ignored
    const again = recordPayment(first.id, { amount: 1000, method: 'razorpay', providerId: 'pay_1' }, later + 2000);
    assert.equal(again.booking.amount_paid, 1000);
  });
});

describe('cancellation & rescheduling policies', () => {
  beforeEach(resetDb);

  function paidBooking(daysAhead: number, start = 1080) {
    const { turfId } = makeTurf();
    const c = makeCustomer();
    const bk = createBooking({ turfId, customerId: c.id, date: addDays(today(), daysAhead), startMinute: start, slots: 1, contactName: 'R', contactPhone: c.phone, paymentOption: 'full' });
    return recordPayment(bk.id, { amount: 1000, method: 'upi' }).booking;
  }

  it('gives a full refund well before the slot and partial later', () => {
    setSettings({ free_cancel_hours: '24', late_cancel_refund_percent: '50', cancel_cutoff_hours: '2' });
    const b = paidBooking(3);
    const q = cancellationQuote(b, 'customer');
    assert.ok(q.allowed && q.refund === 1000);
    const startMs = toEpoch(b.date, b.start_minute);
    const late = cancellationQuote(b, 'customer', startMs - 5 * 3_600_000);
    assert.ok(late.allowed && late.refund === 500);
    const tooLate = cancellationQuote(b, 'customer', startMs - 3_600_000);
    assert.equal(tooLate.allowed, false);
    const c = cancelBooking(b.id, { by: 'customer' });
    assert.equal(c.status, 'cancelled');
    assert.equal(c.payment_status, 'refund_pending');
  });

  it('reschedules within limits', () => {
    setSettings({ max_reschedules: '1', reschedule_cutoff_hours: '6' });
    const b = paidBooking(2);
    const r = rescheduleBooking(b.id, b.date, 600, 'customer');
    assert.equal(r.booking.start_minute, 600);
    assert.equal(r.booking.reschedule_count, 1);
    assert.throws(() => rescheduleBooking(b.id, b.date, 720, 'customer'), /rescheduled/);
    assert.doesNotThrow(() => rescheduleBooking(b.id, b.date, 720, 'admin'), 'admins are not limited');
  });

  it('finds reminders inside the reminder window only', () => {
    setSettings({ reminder_hours_before: '3' });
    const b = paidBooking(1, 600);
    const start = toEpoch(b.date, 600);
    assert.equal(dueReminders(start - 4 * 3_600_000).length, 0);
    assert.equal(dueReminders(start - 2 * 3_600_000).length, 1);
  });
});
