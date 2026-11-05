import { config } from '../config.js';

const MS_MIN = 60_000;
const MS_DAY = 86_400_000;

const partsFmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFmt(tz: string) {
  let f = partsFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFmtCache.set(tz, f);
  }
  return f;
}

function zonedParts(ms: number, tz: string) {
  const out: Record<string, number> = {};
  for (const p of partsFmt(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Offset (ms) of tz from UTC at the given instant. */
function tzOffset(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Current local date (YYYY-MM-DD) and minute-of-day in the business time zone. */
export function nowLocal(nowMs = Date.now(), tz = config.timeZone) {
  const p = zonedParts(nowMs, tz);
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, minute: p.hour * 60 + p.minute };
}

export function today(nowMs = Date.now()) {
  return nowLocal(nowMs).date;
}

function parseDate(date: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, mo, d] = parseDate(date);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = parseDate(date);
  const dt = new Date(Date.UTC(y, m - 1, d) + n * MS_DAY);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function diffDays(a: string, b: string): number {
  const [y1, m1, d1] = parseDate(a);
  const [y2, m2, d2] = parseDate(b);
  return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / MS_DAY);
}

/** 0 = Sunday ... 6 = Saturday */
export function weekday(date: string): number {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Epoch ms of (operating date + minute) in the business time zone. */
export function toEpoch(date: string, minute: number, tz = config.timeZone): number {
  const [y, m, d] = parseDate(date);
  const naive = Date.UTC(y, m - 1, d) + minute * MS_MIN;
  let guess = naive - tzOffset(naive, tz);
  // second pass handles DST transitions
  guess = naive - tzOffset(guess, tz);
  return guess;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const dayName = (dow: number, long = false) => (long ? DAY_NAMES_LONG : DAY_NAMES)[dow] ?? '';

/** "Thu, 5 Nov" */
export function formatDate(date: string): string {
  const [, m, d] = parseDate(date);
  return `${DAY_NAMES[weekday(date)]}, ${d} ${MONTHS[m - 1]}`;
}

/** "Thu, 5 Nov 2026" */
export function formatDateLong(date: string): string {
  const [y] = parseDate(date);
  return `${formatDate(date)} ${y}`;
}

/** 1110 -> "6:30 PM"; values >= 1440 wrap to the next morning. */
export function formatMinute(minute: number): string {
  const m = ((minute % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(mm)} ${suffix}`;
}

export function formatRange(start: number, end: number): string {
  return `${formatMinute(start)} – ${formatMinute(end)}`;
}

/** 1110 -> "18:30"; used for <input type="time"> values */
export function minuteToHHMM(minute: number): string {
  const m = ((minute % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export function hhmmToMinute(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

export function formatDateTime(ms: number, tz = config.timeZone): string {
  const p = zonedParts(ms, tz);
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  return `${formatDate(date)}, ${formatMinute(p.hour * 60 + p.minute)}`;
}

export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hr${h > 1 ? 's' : ''}`;
  return `${m} min`;
}
