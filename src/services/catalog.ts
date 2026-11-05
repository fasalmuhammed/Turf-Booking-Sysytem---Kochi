import { all, get, run } from '../db/index.js';
import type { Faq, Location, Offer, PriceRule, SlotBlock, Turf } from '../types.js';

/* ------------------------------ Locations ------------------------------ */

export function listLocations(activeOnly = false): Location[] {
  return all<Location>(
    `SELECT * FROM locations ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY name`,
  );
}

export const getLocation = (id: number) => get<Location>('SELECT * FROM locations WHERE id = ?', id);

export type LocationInput = Pick<Location, 'name' | 'address' | 'maps_url' | 'contact_phone'> & { active?: boolean };

export function createLocation(input: LocationInput): number {
  return run(
    `INSERT INTO locations (name, address, maps_url, contact_phone, active, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    input.name,
    input.address,
    input.maps_url,
    input.contact_phone,
    input.active ?? true,
    Date.now(),
  ).lastId;
}

export function updateLocation(id: number, input: LocationInput) {
  run(
    `UPDATE locations SET name = ?, address = ?, maps_url = ?, contact_phone = ?, active = ? WHERE id = ?`,
    input.name,
    input.address,
    input.maps_url,
    input.contact_phone,
    input.active ?? true,
    id,
  );
}

/** Deletes a location if it has no turfs, otherwise deactivates it. */
export function removeLocation(id: number): 'deleted' | 'deactivated' {
  const n = get<{ n: number }>('SELECT COUNT(*) AS n FROM turfs WHERE location_id = ?', id)!.n;
  if (n === 0) {
    run('DELETE FROM locations WHERE id = ?', id);
    return 'deleted';
  }
  run('UPDATE locations SET active = 0 WHERE id = ?', id);
  run('UPDATE turfs SET active = 0 WHERE location_id = ?', id);
  return 'deactivated';
}

/* -------------------------------- Turfs -------------------------------- */

export interface TurfWithLocation extends Turf {
  location_name: string;
  location_active: number;
}

export function listTurfs(opts: { activeOnly?: boolean; locationId?: number } = {}): TurfWithLocation[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.activeOnly) where.push('t.active = 1 AND l.active = 1');
  if (opts.locationId) {
    where.push('t.location_id = ?');
    params.push(opts.locationId);
  }
  return all<TurfWithLocation>(
    `SELECT t.*, l.name AS location_name, l.active AS location_active
       FROM turfs t JOIN locations l ON l.id = t.location_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY l.name, t.sort_order, t.name`,
    ...params,
  );
}

export const getTurf = (id: number) =>
  get<TurfWithLocation>(
    `SELECT t.*, l.name AS location_name, l.active AS location_active
       FROM turfs t JOIN locations l ON l.id = t.location_id WHERE t.id = ?`,
    id,
  );

export type TurfInput = Omit<Turf, 'id' | 'created_at' | 'updated_at' | 'active'> & { active: boolean };

export function validateTurf(t: TurfInput): string[] {
  const errors: string[] = [];
  if (!t.name.trim()) errors.push('Name is required');
  if (![15, 30, 45, 60, 90, 120].includes(t.slot_minutes)) errors.push('Slot duration must be 15, 30, 45, 60, 90 or 120 minutes');
  if (t.close_minute <= t.open_minute) errors.push('Closing time must be after opening time');
  if (t.close_minute - t.open_minute > 1440) errors.push('Operating hours cannot exceed 24 hours');
  if (t.close_minute - t.open_minute < t.slot_minutes) errors.push('Operating hours must fit at least one slot');
  if (t.base_price < 0) errors.push('Price cannot be negative');
  if (t.advance_percent < 0 || t.advance_percent > 100) errors.push('Advance % must be between 0 and 100');
  if (t.max_slots_per_booking < 1 || t.max_slots_per_booking > 3) errors.push('Max slots per booking must be 1–3');
  return errors;
}

export function createTurf(t: TurfInput): number {
  const now = Date.now();
  return run(
    `INSERT INTO turfs (location_id, name, sports, description, open_minute, close_minute, slot_minutes, base_price,
                        advance_percent, max_slots_per_booking, closed_days, active, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    t.location_id,
    t.name.trim(),
    t.sports,
    t.description,
    t.open_minute,
    t.close_minute,
    t.slot_minutes,
    t.base_price,
    t.advance_percent,
    t.max_slots_per_booking,
    t.closed_days,
    t.active,
    t.sort_order,
    now,
    now,
  ).lastId;
}

export function updateTurf(id: number, t: TurfInput) {
  run(
    `UPDATE turfs SET location_id = ?, name = ?, sports = ?, description = ?, open_minute = ?, close_minute = ?,
            slot_minutes = ?, base_price = ?, advance_percent = ?, max_slots_per_booking = ?, closed_days = ?,
            active = ?, sort_order = ?, updated_at = ?
      WHERE id = ?`,
    t.location_id,
    t.name.trim(),
    t.sports,
    t.description,
    t.open_minute,
    t.close_minute,
    t.slot_minutes,
    t.base_price,
    t.advance_percent,
    t.max_slots_per_booking,
    t.closed_days,
    t.active,
    t.sort_order,
    Date.now(),
    id,
  );
}

/** Hard-deletes a turf that has never been booked; otherwise deactivates it so history is kept. */
export function removeTurf(id: number): 'deleted' | 'deactivated' {
  const n = get<{ n: number }>('SELECT COUNT(*) AS n FROM bookings WHERE turf_id = ?', id)!.n;
  if (n === 0) {
    run('DELETE FROM turfs WHERE id = ?', id);
    return 'deleted';
  }
  run('UPDATE turfs SET active = 0, updated_at = ? WHERE id = ?', Date.now(), id);
  return 'deactivated';
}

/* ----------------------------- Price rules ----------------------------- */

export const listPriceRules = (turfId: number) =>
  all<PriceRule>('SELECT * FROM price_rules WHERE turf_id = ? ORDER BY start_minute, id', turfId);

export function addPriceRule(r: Omit<PriceRule, 'id'>) {
  return run(
    'INSERT INTO price_rules (turf_id, label, days, start_minute, end_minute, price) VALUES (?, ?, ?, ?, ?, ?)',
    r.turf_id,
    r.label,
    r.days,
    r.start_minute,
    r.end_minute,
    r.price,
  ).lastId;
}

export const deletePriceRule = (id: number) => run('DELETE FROM price_rules WHERE id = ?', id);

/* -------------------------------- Offers ------------------------------- */

export const listOffers = (opts: { activeOnly?: boolean } = {}) =>
  all<Offer & { turf_name: string | null }>(
    `SELECT o.*, t.name AS turf_name FROM offers o LEFT JOIN turfs t ON t.id = o.turf_id
      ${opts.activeOnly ? 'WHERE o.active = 1' : ''} ORDER BY o.active DESC, o.id DESC`,
  );

export type OfferInput = Omit<Offer, 'id' | 'created_at' | 'active'> & { active: boolean };

export function createOffer(o: OfferInput) {
  return run(
    `INSERT INTO offers (turf_id, title, description, discount_type, discount_value, valid_from, valid_to, days,
                         start_minute, end_minute, min_slots, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    o.turf_id,
    o.title,
    o.description,
    o.discount_type,
    o.discount_value,
    o.valid_from,
    o.valid_to,
    o.days,
    o.start_minute,
    o.end_minute,
    o.min_slots,
    o.active,
    Date.now(),
  ).lastId;
}

export const setOfferActive = (id: number, active: boolean) => run('UPDATE offers SET active = ? WHERE id = ?', active, id);
export const deleteOffer = (id: number) => run('DELETE FROM offers WHERE id = ?', id);

/* ------------------------------ Slot blocks ---------------------------- */

export function listBlocks(opts: { turfId?: number; fromDate?: string; date?: string } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.turfId) {
    where.push('b.turf_id = ?');
    params.push(opts.turfId);
  }
  if (opts.date) {
    where.push('b.date = ?');
    params.push(opts.date);
  }
  if (opts.fromDate) {
    where.push('b.date >= ?');
    params.push(opts.fromDate);
  }
  return all<SlotBlock & { turf_name: string }>(
    `SELECT b.*, t.name AS turf_name FROM slot_blocks b JOIN turfs t ON t.id = b.turf_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.date, b.start_minute`,
    ...params,
  );
}

export function createBlock(b: Omit<SlotBlock, 'id' | 'created_at'>) {
  return run(
    'INSERT INTO slot_blocks (turf_id, date, start_minute, end_minute, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    b.turf_id,
    b.date,
    b.start_minute,
    b.end_minute,
    b.reason,
    b.created_by,
    Date.now(),
  ).lastId;
}

export const deleteBlock = (id: number) => run('DELETE FROM slot_blocks WHERE id = ?', id);

/* --------------------------------- FAQs -------------------------------- */

export const listFaqs = (activeOnly = false) =>
  all<Faq>(`SELECT * FROM faqs ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort_order, id`);

export const getFaq = (id: number) => get<Faq>('SELECT * FROM faqs WHERE id = ?', id);

export function saveFaq(f: { id?: number; question: string; answer: string; sort_order: number; active: boolean }) {
  if (f.id) {
    run('UPDATE faqs SET question = ?, answer = ?, sort_order = ?, active = ? WHERE id = ?', f.question, f.answer, f.sort_order, f.active, f.id);
    return f.id;
  }
  return run('INSERT INTO faqs (question, answer, sort_order, active) VALUES (?, ?, ?, ?)', f.question, f.answer, f.sort_order, f.active).lastId;
}

export const deleteFaq = (id: number) => run('DELETE FROM faqs WHERE id = ?', id);
