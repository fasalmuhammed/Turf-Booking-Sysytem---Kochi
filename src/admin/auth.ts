import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { get, run } from '../db/index.js';
import { randomToken, safeEqual, sha256 } from '../utils/misc.js';

const SESSION_COOKIE = 'tb_admin';
const SESSION_TTL_MS = 12 * 3_600_000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export interface AdminUser {
  id: number;
  username: string;
  csrf: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    admin?: AdminUser;
    rawBody?: Buffer;
  }
}

/* ------------------------------ Passwords ------------------------------ */

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(expected, actual);
}

export function passwordProblems(pw: string): string | null {
  if (pw.length < 10) return 'Password must be at least 10 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}

export function createAdmin(username: string, password: string): number {
  return run('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)', username.trim(), hashPassword(password), Date.now()).lastId;
}

export function setAdminPassword(id: number, password: string) {
  run('UPDATE admins SET password_hash = ? WHERE id = ?', hashPassword(password), id);
  run('DELETE FROM admin_sessions WHERE admin_id = ?', id);
}

export const adminCount = () => get<{ n: number }>('SELECT COUNT(*) AS n FROM admins')!.n;

/* ---------------------------- Rate limiting ---------------------------- */

const failures = new Map<string, { count: number; first: number }>();
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;

export function isLockedOut(key: string, nowMs = Date.now()): boolean {
  const f = failures.get(key);
  if (!f) return false;
  if (nowMs - f.first > WINDOW_MS) {
    failures.delete(key);
    return false;
  }
  return f.count >= MAX_FAILURES;
}

function recordFailure(key: string, nowMs = Date.now()) {
  const f = failures.get(key);
  if (!f || nowMs - f.first > WINDOW_MS) failures.set(key, { count: 1, first: nowMs });
  else f.count++;
}

/* ------------------------------- Sessions ------------------------------ */

export function attemptLogin(username: string, password: string, ip: string): { ok: true; token: string } | { ok: false; error: string } {
  const keys = [`ip:${ip}`, `user:${username.toLowerCase()}`];
  if (keys.some((k) => isLockedOut(k))) return { ok: false, error: 'Too many failed attempts. Please wait 15 minutes and try again.' };
  const admin = get<{ id: number; password_hash: string }>('SELECT id, password_hash FROM admins WHERE username = ?', username.trim());
  // always run a hash so response time doesn't reveal whether the user exists
  const ok = admin ? verifyPassword(password, admin.password_hash) : (verifyPassword(password, DUMMY_HASH), false);
  if (!admin || !ok) {
    keys.forEach((k) => recordFailure(k));
    return { ok: false, error: 'Invalid username or password.' };
  }
  keys.forEach((k) => failures.delete(k));
  const token = randomToken(32);
  const now = Date.now();
  run(
    'INSERT INTO admin_sessions (token_hash, admin_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    sha256(token),
    admin.id,
    randomToken(24),
    now + SESSION_TTL_MS,
    now,
  );
  run('UPDATE admins SET last_login_at = ? WHERE id = ?', now, admin.id);
  audit(admin.id, 'login', `ip=${ip}`);
  return { ok: true, token };
}

const DUMMY_HASH = hashPassword(randomToken(12));

export function logout(token: string | undefined) {
  if (token) run('DELETE FROM admin_sessions WHERE token_hash = ?', sha256(token));
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

export const sessionToken = (req: Request) => parseCookies(req.headers.cookie)[SESSION_COOKIE];

const secureCookies = () => config.isProduction || config.publicBaseUrl.startsWith('https://');

export function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(),
    path: '/admin',
    maxAge: SESSION_TTL_MS,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: '/admin' });
}

/** Loads the admin for this request (if any). */
export function loadAdmin(req: Request, _res: Response, next: NextFunction) {
  const token = sessionToken(req);
  if (token) {
    const row = get<{ admin_id: number; username: string; csrf_token: string; expires_at: number }>(
      `SELECT s.admin_id, a.username, s.csrf_token, s.expires_at FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
        WHERE s.token_hash = ?`,
      sha256(token),
    );
    if (row && row.expires_at > Date.now()) req.admin = { id: row.admin_id, username: row.username, csrf: row.csrf_token };
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.admin) {
    if (req.method === 'GET') res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    else res.status(401).send('Not signed in');
    return;
  }
  next();
}

/** Rejects state-changing requests without the session's CSRF token. */
export function csrfProtect(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const sent = String((req.body as Record<string, unknown> | undefined)?._csrf ?? req.header('x-csrf-token') ?? '');
  if (!req.admin || !sent || !safeEqual(sent, req.admin.csrf)) {
    res.status(403).send('Invalid or missing CSRF token. Please reload the page and try again.');
    return;
  }
  next();
}

export function audit(adminId: number | null, action: string, details = '') {
  run('INSERT INTO audit_log (admin_id, action, details, created_at) VALUES (?, ?, ?, ?)', adminId, action, details.slice(0, 1000), Date.now());
}
