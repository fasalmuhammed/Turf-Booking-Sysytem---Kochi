import type { Request, Response } from 'express';
import { isMock } from '../whatsapp/client.js';
import { attentionCounts } from '../services/reports.js';
import { getSetting } from '../services/settings.js';
import { html, raw, SafeHtml } from './html.js';

/* -------------------------------- Flash -------------------------------- */

const flashes = new Map<string, { type: 'ok' | 'err'; text: string }>();

export function flash(req: Request, type: 'ok' | 'err', text: string) {
  if (req.admin) flashes.set(req.admin.csrf, { type, text });
}

function takeFlash(req: Request) {
  if (!req.admin) return null;
  const f = flashes.get(req.admin.csrf);
  flashes.delete(req.admin.csrf);
  return f ?? null;
}

/** Redirects (303) to an admin URL with an optional flash message. */
export function back(req: Request, res: Response, target: string, type?: 'ok' | 'err', text?: string) {
  if (type && text) flash(req, type, text);
  res.redirect(303, target.startsWith('/admin') ? target : '/admin');
}

/* ------------------------------ Form helpers ---------------------------- */

export const csrfField = (req: Request) => html`<input type="hidden" name="_csrf" value="${req.admin?.csrf ?? ''}">`;

export const str = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
export const int = (v: unknown, fallback = 0) => {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? Math.round(n) : fallback;
};
export const checked = (v: unknown) => v === 'on' || v === '1' || v === 'true';
export const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
export const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined ? [] : [String(v)]);

export function badge(text: string, tone: 'green' | 'amber' | 'red' | 'blue' | 'grey' = 'grey') {
  return html`<span class="badge ${tone}">${text}</span>`;
}

export const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'blue' | 'grey'> = {
  pending_payment: 'amber',
  confirmed: 'green',
  cancelled: 'red',
  expired: 'grey',
  completed: 'blue',
  no_show: 'red',
  unpaid: 'grey',
  verification_pending: 'amber',
  advance_paid: 'blue',
  paid: 'green',
  refund_pending: 'amber',
  refunded: 'grey',
};

export const statusBadge = (s: string) => badge(s.replace(/_/g, ' '), STATUS_TONE[s] ?? 'grey');

/* -------------------------------- Layout ------------------------------- */

const NAV: { href: string; label: string; icon: string; key?: 'pendingVerifications' | 'humanHandoffs' }[] = [
  { href: '/admin', label: 'Dashboard', icon: '📊' },
  { href: '/admin/bookings', label: 'Bookings', icon: '📋' },
  { href: '/admin/schedule', label: 'Schedule & blocks', icon: '🗓️' },
  { href: '/admin/payments', label: 'Payments', icon: '💳', key: 'pendingVerifications' },
  { href: '/admin/inbox', label: 'Inbox', icon: '💬', key: 'humanHandoffs' },
  { href: '/admin/turfs', label: 'Turfs & locations', icon: '🏟️' },
  { href: '/admin/offers', label: 'Offers', icon: '🔥' },
  { href: '/admin/customers', label: 'Customers', icon: '👥' },
  { href: '/admin/faqs', label: 'FAQs', icon: '❓' },
  { href: '/admin/reports', label: 'Revenue reports', icon: '📈' },
  { href: '/admin/settings', label: 'Settings', icon: '⚙️' },
];

export function page(req: Request, title: string, content: SafeHtml | SafeHtml[], opts: { scripts?: string[] } = {}): string {
  const counts = attentionCounts();
  const path = req.path === '/' ? '/admin' : `/admin${req.path}`;
  const f = takeFlash(req);
  const nav = [...NAV, ...(isMock() ? [{ href: '/admin/simulator', label: 'WhatsApp simulator', icon: '🧪' } as const] : [])];
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · ${getSetting('business_name')} Admin</title>
<link rel="stylesheet" href="/static/admin.css">
</head>
<body>
<div class="shell">
  <aside class="sidebar">
    <div class="brand">⚽ ${getSetting('business_name')}<small>Turf admin</small></div>
    <nav>
      ${nav.map((n) => {
        const active = n.href === '/admin' ? path === '/admin' : path.startsWith(n.href);
        const count = 'key' in n && n.key ? counts[n.key] : 0;
        return html`<a href="${n.href}" class="${active ? 'active' : ''}"><span>${n.icon}</span> ${n.label}${count ? html`<em>${count}</em>` : ''}</a>`;
      })}
    </nav>
    <div class="me">
      Signed in as <b>${req.admin?.username}</b>
      <form method="post" action="/admin/logout">${csrfField(req)}<button class="link">Sign out</button></form>
    </div>
  </aside>
  <main>
    <header class="top"><h1>${title}</h1></header>
    ${f ? html`<div class="flash ${f.type}">${f.text}</div>` : ''}
    ${content}
  </main>
</div>
${['/static/admin.js', ...(opts.scripts ?? [])].map((s) => html`<script src="${s}"></script>`)}
</body>
</html>`.value;
}

export function loginPage(error: string, next: string, loginToken: string) {
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in · ${getSetting('business_name')}</title><link rel="stylesheet" href="/static/admin.css"></head>
<body class="login-body">
<form class="login card" method="post" action="/admin/login">
  <div class="brand big">⚽ ${getSetting('business_name')}</div>
  <p class="muted">Admin dashboard</p>
  ${error ? html`<div class="flash err">${error}</div>` : ''}
  <input type="hidden" name="next" value="${next}">
  <input type="hidden" name="_login" value="${loginToken}">
  <label>Username<input name="username" autocomplete="username" required autofocus></label>
  <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
  <button class="btn primary wide">Sign in</button>
</form>
</body></html>`.value;
}

export const empty = (text: string) => html`<div class="empty">${text}</div>`;
export { raw, html };
