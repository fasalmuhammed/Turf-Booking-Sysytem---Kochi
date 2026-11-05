import { all } from '../db/index.js';
import type { Offer, Turf } from '../types.js';
import { addDays, diffDays, today, toEpoch, weekday } from '../utils/time.js';
import { parseIntList } from '../utils/misc.js';
import { getNumber } from './settings.js';
import { loadActiveOffers, loadPriceRules, offerApplies, slotPrice } from './pricing.js';

export interface Interval {
  start: number;
  end: number;
  kind: 'booking' | 'block';
  ref: number;
  label: string;
}

export type SlotState = 'available' | 'booked' | 'held' | 'blocked' | 'past' | 'closed';

export interface Slot {
  start: number;
  end: number;
  price: number;
  state: SlotState;
  offer: Offer | null;
  label: string;
}

export function isClosedDay(turf: Turf, date: string): boolean {
  return parseIntList(turf.closed_days).includes(weekday(date));
}

/**
 * Busy intervals (bookings that occupy the slot + admin blocks) for a turf on
 * an operating date, expressed in that date's minute scale. Late-night
 * bookings from the previous operating date that spill past midnight are
 * shifted into this date's scale so they still block overlapping slots.
 */
export function busyIntervals(turfId: number, date: string, nowMs = Date.now(), excludeBookingId?: number): Interval[] {
  const prev = addDays(date, -1);
  const rows = all<{ id: number; date: string; start_minute: number; end_minute: number; status: string; hold_expires_at: number | null; code: string }>(
    `SELECT id, date, start_minute, end_minute, status, hold_expires_at, code FROM bookings
      WHERE turf_id = ? AND (date = ? OR (date = ? AND end_minute > 1440))
        AND status IN ('pending_payment','confirmed','completed','no_show')`,
    turfId,
    date,
    prev,
  );
  const out: Interval[] = [];
  for (const r of rows) {
    if (r.id === excludeBookingId) continue;
    // an unpaid hold stops blocking once it expires (unless payment is being verified: hold_expires_at NULL)
    if (r.status === 'pending_payment' && r.hold_expires_at !== null && r.hold_expires_at <= nowMs) continue;
    const shift = r.date === date ? 0 : -1440;
    out.push({
      start: r.start_minute + shift,
      end: r.end_minute + shift,
      kind: 'booking',
      ref: r.id,
      label: r.status === 'pending_payment' ? `held:${r.code}` : r.code,
    });
  }
  const blocks = all<{ id: number; date: string; start_minute: number; end_minute: number; reason: string }>(
    `SELECT id, date, start_minute, end_minute, reason FROM slot_blocks
      WHERE turf_id = ? AND (date = ? OR (date = ? AND end_minute > 1440))`,
    turfId,
    date,
    prev,
  );
  for (const b of blocks) {
    const shift = b.date === date ? 0 : -1440;
    out.push({ start: b.start_minute + shift, end: b.end_minute + shift, kind: 'block', ref: b.id, label: b.reason || 'Blocked' });
  }
  return out;
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;

/** All slots for a turf/date with their state. */
export function getSlots(turf: Turf, date: string, nowMs = Date.now()): Slot[] {
  const rules = loadPriceRules(turf.id);
  const offers = loadActiveOffers();
  const busy = busyIntervals(turf.id, date, nowMs);
  const closed = isClosedDay(turf, date);
  const leadMs = getNumber('min_lead_minutes') * 60_000;
  const slots: Slot[] = [];
  for (let s = turf.open_minute; s + turf.slot_minutes <= turf.close_minute; s += turf.slot_minutes) {
    const e = s + turf.slot_minutes;
    let state: SlotState = 'available';
    let label = '';
    if (closed) state = 'closed';
    else if (toEpoch(date, s) < nowMs + leadMs) state = 'past';
    else {
      const hit = busy.find((b) => overlaps(s, e, b.start, b.end));
      if (hit) {
        state = hit.kind === 'block' ? 'blocked' : hit.label.startsWith('held:') ? 'held' : 'booked';
        label = hit.label.replace(/^held:/, '');
      }
    }
    const offer = offers.find((o) => offerApplies(o, turf.id, date, s, 1)) ?? null;
    slots.push({ start: s, end: e, price: slotPrice(turf, rules, date, s), state, offer, label });
  }
  return slots;
}

export function availableSlots(turf: Turf, date: string, nowMs = Date.now()): Slot[] {
  return getSlots(turf, date, nowMs).filter((s) => s.state === 'available');
}

/** True if [start, end) on date is inside operating hours, aligned and free. */
export function isRangeBookable(
  turf: Turf,
  date: string,
  start: number,
  end: number,
  opts: { nowMs?: number; excludeBookingId?: number; ignoreLeadTime?: boolean } = {},
): { ok: true } | { ok: false; reason: string } {
  const nowMs = opts.nowMs ?? Date.now();
  if (isClosedDay(turf, date)) return { ok: false, reason: 'The turf is closed on that day.' };
  if (start < turf.open_minute || end > turf.close_minute) return { ok: false, reason: 'That time is outside operating hours.' };
  if ((start - turf.open_minute) % turf.slot_minutes !== 0 || (end - start) % turf.slot_minutes !== 0 || end <= start) {
    return { ok: false, reason: 'That time does not match the slot schedule.' };
  }
  const lead = opts.ignoreLeadTime ? 0 : getNumber('min_lead_minutes') * 60_000;
  if (toEpoch(date, start) < nowMs + lead) return { ok: false, reason: 'That slot has already started or is too soon to book.' };
  const busy = busyIntervals(turf.id, date, nowMs, opts.excludeBookingId);
  const hit = busy.find((b) => overlaps(start, end, b.start, b.end));
  if (hit) return { ok: false, reason: hit.kind === 'block' ? 'That slot is unavailable (blocked).' : 'That slot has just been booked by someone else.' };
  return { ok: true };
}

/** How many consecutive free slots (including the first) start at `start`, up to `max`. */
export function consecutiveFree(turf: Turf, date: string, start: number, max: number, nowMs = Date.now(), excludeBookingId?: number): number {
  let n = 0;
  for (let i = 0; i < max; i++) {
    const s = start + i * turf.slot_minutes;
    const r = isRangeBookable(turf, date, s, s + turf.slot_minutes, { nowMs, excludeBookingId, ignoreLeadTime: i > 0 });
    if (!r.ok) break;
    n++;
  }
  return n;
}

export function bookingWindowDates(nowMs = Date.now()): string[] {
  const days = Math.max(1, Math.min(60, getNumber('booking_window_days')));
  const t = today(nowMs);
  return Array.from({ length: days }, (_, i) => addDays(t, i));
}

export function isWithinBookingWindow(date: string, nowMs = Date.now()): boolean {
  const d = diffDays(date, today(nowMs));
  return d >= 0 && d < Math.max(1, getNumber('booking_window_days'));
}

/** Dates in the booking window with their count of available slots. */
export function availableDates(turf: Turf, nowMs = Date.now()): { date: string; free: number }[] {
  return bookingWindowDates(nowMs).map((date) => ({ date, free: availableSlots(turf, date, nowMs).length }));
}
