import crypto from 'node:crypto';
import { config } from '../config.js';

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
export const rupees = (n: number) => `₹${inr.format(Math.round(n))}`;

// Crockford-ish alphabet without easily confused characters (0/O, 1/I/L)
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function randomCode(len: number): string {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return s;
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function hmac(data: string, secret = config.appSecret): string {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Normalises an Indian mobile number to 91XXXXXXXXXX; returns null if invalid. */
export function normalizePhone(input: string, defaultCountry = '91'): string | null {
  const digits = input.replace(/\D/g, '');
  if (/^[6-9]\d{9}$/.test(digits)) return defaultCountry + digits;
  if (/^0[6-9]\d{9}$/.test(digits)) return defaultCountry + digits.slice(1);
  if (/^91[6-9]\d{9}$/.test(digits)) return digits;
  // other countries: accept 8–15 digit E.164 without +
  if (digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0') && !digits.startsWith('91')) return digits;
  return null;
}

export function displayPhone(phone: string): string {
  if (/^91\d{10}$/.test(phone)) return `+91 ${phone.slice(2, 7)} ${phone.slice(7)}`;
  return `+${phone}`;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

export function parseIntList(s: string): number[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .map(Number)
    .filter((n) => Number.isInteger(n));
}
