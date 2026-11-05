import { all } from '../db/index.js';
import type { Offer, PriceRule, Turf } from '../types.js';
import { weekday } from '../utils/time.js';
import { parseIntList } from '../utils/misc.js';
import { getBool } from './settings.js';

function dayMatches(days: string, dow: number) {
  const list = parseIntList(days);
  return list.length === 0 || list.includes(dow);
}

/** Hourly rate for a slot that starts at `start` on `date`. First matching rule wins. */
export function hourlyRate(turf: Turf, rules: PriceRule[], date: string, start: number): { rate: number; label: string } {
  const dow = weekday(date);
  for (const r of rules) {
    if (dayMatches(r.days, dow) && start >= r.start_minute && start < r.end_minute) {
      return { rate: r.price, label: r.label };
    }
  }
  return { rate: turf.base_price, label: '' };
}

export function slotPrice(turf: Turf, rules: PriceRule[], date: string, start: number): number {
  return Math.round((hourlyRate(turf, rules, date, start).rate * turf.slot_minutes) / 60);
}

export function offerApplies(o: Offer, turfId: number, date: string, start: number, slots: number): boolean {
  if (!o.active) return false;
  if (o.turf_id !== null && o.turf_id !== turfId) return false;
  if (o.valid_from && date < o.valid_from) return false;
  if (o.valid_to && date > o.valid_to) return false;
  if (!dayMatches(o.days, weekday(date))) return false;
  if (o.start_minute !== null && start < o.start_minute) return false;
  if (o.end_minute !== null && start >= o.end_minute) return false;
  if (slots < o.min_slots) return false;
  return true;
}

export function offerDiscount(o: Offer, gross: number): number {
  const d = o.discount_type === 'percent' ? Math.round((gross * o.discount_value) / 100) : o.discount_value;
  return Math.max(0, Math.min(gross, d));
}

export const loadPriceRules = (turfId: number) =>
  all<PriceRule>('SELECT * FROM price_rules WHERE turf_id = ? ORDER BY id', turfId);

export const loadActiveOffers = () => all<Offer>('SELECT * FROM offers WHERE active = 1');

export interface Quote {
  gross: number;
  discount: number;
  total: number;
  offer: Offer | null;
  advance: number;
  /** false when advance payment isn't offered for this turf */
  advanceAllowed: boolean;
  slotPrices: number[];
}

/** Price for `slots` consecutive slots starting at `start`. Picks the single best applicable offer. */
export function quote(turf: Turf, date: string, start: number, slots: number, rules?: PriceRule[], offers?: Offer[]): Quote {
  rules ??= loadPriceRules(turf.id);
  offers ??= loadActiveOffers();
  const slotPrices: number[] = [];
  for (let i = 0; i < slots; i++) slotPrices.push(slotPrice(turf, rules, date, start + i * turf.slot_minutes));
  const gross = slotPrices.reduce((a, b) => a + b, 0);

  let best: Offer | null = null;
  let bestDiscount = 0;
  for (const o of offers) {
    if (!offerApplies(o, turf.id, date, start, slots)) continue;
    const d = offerDiscount(o, gross);
    if (d > bestDiscount) {
      best = o;
      bestDiscount = d;
    }
  }
  const total = gross - bestDiscount;
  const advanceAllowed = getBool('allow_advance_payment') && turf.advance_percent > 0 && turf.advance_percent < 100 && total > 0;
  const advance = advanceAllowed ? Math.ceil((total * turf.advance_percent) / 100) : total;
  return { gross, discount: bestDiscount, total, offer: best, advance, advanceAllowed, slotPrices };
}
