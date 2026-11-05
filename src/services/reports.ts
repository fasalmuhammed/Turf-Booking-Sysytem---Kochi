import { all, get } from '../db/index.js';
import { addDays, nowLocal, today, toEpoch, weekday } from '../utils/time.js';

interface PayRow {
  amount: number;
  status: string;
  verified_at: number;
}

function localDate(ms: number) {
  return nowLocal(ms).date;
}

function collections(fromDate: string, toDate: string) {
  const fromMs = toEpoch(fromDate, 0);
  const toMs = toEpoch(addDays(toDate, 1), 0);
  return all<PayRow>(
    `SELECT amount, status, verified_at FROM payments
      WHERE status IN ('success','refunded') AND verified_at >= ? AND verified_at < ?`,
    fromMs,
    toMs,
  );
}

function bookedValue(fromDate: string, toDate: string) {
  return get<{ value: number; n: number; hours: number }>(
    `SELECT COALESCE(SUM(total_amount), 0) AS value, COUNT(*) AS n,
            COALESCE(SUM(end_minute - start_minute), 0) / 60.0 AS hours
       FROM bookings WHERE status IN ('confirmed','completed','no_show') AND date BETWEEN ? AND ?`,
    fromDate,
    toDate,
  )!;
}

export interface PeriodSummary {
  label: string;
  from: string;
  to: string;
  collected: number;
  refunded: number;
  net: number;
  bookedValue: number;
  bookings: number;
  hours: number;
}

function summarize(label: string, from: string, to: string): PeriodSummary {
  let collected = 0;
  let refunded = 0;
  for (const p of collections(from, to)) {
    if (p.status === 'success') collected += p.amount;
    else refunded += p.amount;
  }
  const bv = bookedValue(from, to);
  return { label, from, to, collected, refunded, net: collected - refunded, bookedValue: bv.value, bookings: bv.n, hours: Math.round(bv.hours * 10) / 10 };
}

export function revenueSummary(nowMs = Date.now()) {
  const t = today(nowMs);
  const dow = weekday(t);
  const weekStart = addDays(t, -((dow + 6) % 7)); // Monday
  const monthStart = `${t.slice(0, 8)}01`;
  // periods run to their end so upcoming bookings count towards booked value
  const monthEnd = addDays(`${addDays(monthStart, 32).slice(0, 8)}01`, -1);
  return {
    today: summarize('Today', t, t),
    week: summarize('This week', weekStart, addDays(weekStart, 6)),
    month: summarize('This month', monthStart, monthEnd),
  };
}

export function summaryForRange(from: string, to: string) {
  return summarize(`${from} → ${to}`, from, to);
}

/** Per-day series of net collections and booked value. */
export function dailySeries(from: string, to: string) {
  const days: { date: string; net: number; booked: number; bookings: number }[] = [];
  const index = new Map<string, (typeof days)[number]>();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const row = { date: d, net: 0, booked: 0, bookings: 0 };
    days.push(row);
    index.set(d, row);
  }
  for (const p of collections(from, to)) {
    const row = index.get(localDate(p.verified_at));
    if (row) row.net += p.status === 'success' ? p.amount : -p.amount;
  }
  for (const b of all<{ date: string; v: number; n: number }>(
    `SELECT date, SUM(total_amount) AS v, COUNT(*) AS n FROM bookings
      WHERE status IN ('confirmed','completed','no_show') AND date BETWEEN ? AND ? GROUP BY date`,
    from,
    to,
  )) {
    const row = index.get(b.date);
    if (row) {
      row.booked = b.v;
      row.bookings = b.n;
    }
  }
  return days;
}

export function byTurf(from: string, to: string) {
  return all<{ turf_id: number; turf_name: string; location_name: string; bookings: number; value: number; paid: number; hours: number }>(
    `SELECT t.id AS turf_id, t.name AS turf_name, l.name AS location_name,
            COUNT(b.id) AS bookings, COALESCE(SUM(b.total_amount), 0) AS value, COALESCE(SUM(b.amount_paid), 0) AS paid,
            COALESCE(SUM(b.end_minute - b.start_minute), 0) / 60.0 AS hours
       FROM turfs t JOIN locations l ON l.id = t.location_id
       LEFT JOIN bookings b ON b.turf_id = t.id AND b.status IN ('confirmed','completed','no_show') AND b.date BETWEEN ? AND ?
      GROUP BY t.id ORDER BY value DESC`,
    from,
    to,
  );
}

export function attentionCounts() {
  const n = (sql: string) => get<{ n: number }>(sql)!.n;
  return {
    pendingVerifications: n("SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'"),
    refundsPending: n("SELECT COUNT(*) AS n FROM bookings WHERE payment_status = 'refund_pending'"),
    humanHandoffs: n("SELECT COUNT(*) AS n FROM chat_sessions WHERE mode = 'human'"),
    holds: n("SELECT COUNT(*) AS n FROM bookings WHERE status = 'pending_payment'"),
  };
}
