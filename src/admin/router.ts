import express, { type Request, type Response } from 'express';
import { config } from '../config.js';
import { randomToken, safeEqual } from '../utils/misc.js';
import { attemptLogin, clearSessionCookie, csrfProtect, loadAdmin, logout, parseCookies, requireAdmin, sessionToken, setSessionCookie } from './auth.js';
import { loginPage } from './layout.js';
import { registerBookings } from './pages/bookings.js';
import { registerCatalog } from './pages/catalog.js';
import { registerDashboard } from './pages/dashboard.js';
import { registerPeople } from './pages/people.js';
import { registerSettings } from './pages/settings.js';

const LOGIN_COOKIE = 'tb_login';

function safeNext(next: unknown): string {
  const n = String(next ?? '');
  return n.startsWith('/admin') && !n.startsWith('//') && !n.includes('\\') ? n : '/admin';
}

export function adminRouter() {
  const r = express.Router();

  r.use((_req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    next();
  });
  r.use(loadAdmin);

  /* ------------------------------ Login ------------------------------ */
  const showLogin = (req: Request, res: Response, error = '', status = 200) => {
    const token = randomToken(18);
    res.cookie(LOGIN_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: config.isProduction, path: '/admin', maxAge: 30 * 60_000 });
    const msg = error || (req.query.changed ? 'Password changed — please sign in again.' : '');
    res.status(status).send(loginPage(msg, safeNext(req.query.next ?? (req.body as Record<string, unknown> | undefined)?.next), token));
  };

  r.get('/login', (req, res) => {
    if (req.admin) return res.redirect('/admin');
    showLogin(req, res);
  });

  r.post('/login', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const cookieToken = parseCookies(req.headers.cookie)[LOGIN_COOKIE] ?? '';
    if (!cookieToken || !safeEqual(cookieToken, String(b._login ?? ''))) {
      return showLogin(req, res, 'Your session expired — please try again.', 400);
    }
    const result = attemptLogin(String(b.username ?? '').slice(0, 64), String(b.password ?? '').slice(0, 200), req.ip ?? 'unknown');
    if (!result.ok) return showLogin(req, res, result.error, 401);
    res.clearCookie(LOGIN_COOKIE, { path: '/admin' });
    setSessionCookie(res, result.token);
    res.redirect(303, safeNext(b.next));
  });

  /* ------------------------- Authenticated area ----------------------- */
  r.use(requireAdmin);
  r.use(csrfProtect);

  r.post('/logout', (req, res) => {
    logout(sessionToken(req));
    clearSessionCookie(res);
    res.redirect(303, '/admin/login');
  });

  registerDashboard(r);
  registerBookings(r);
  registerCatalog(r);
  registerPeople(r);
  registerSettings(r);

  return r;
}
