import type { Router } from 'express';
import { config, razorpayEnabled } from '../../config.js';
import { all, get } from '../../db/index.js';
import { getAllSettings, setSettings, type SettingKey } from '../../services/settings.js';
import { formatDateTime } from '../../utils/time.js';
import { audit, createAdmin, passwordProblems, setAdminPassword, verifyPassword } from '../auth.js';
import { html } from '../html.js';
import { back, badge, body, checked, csrfField, page, str } from '../layout.js';

const NUMERIC: Partial<Record<SettingKey, [number, number]>> = {
  booking_window_days: [1, 60],
  hold_minutes: [5, 240],
  min_lead_minutes: [0, 1440],
  free_cancel_hours: [0, 720],
  late_cancel_refund_percent: [0, 100],
  cancel_cutoff_hours: [0, 720],
  reschedule_cutoff_hours: [0, 720],
  max_reschedules: [0, 10],
  reminder_hours_before: [0, 72],
};

const TEXT_LIMITS: Partial<Record<SettingKey, number>> = {
  business_name: 60,
  welcome_message: 600,
  upi_vpa: 60,
  upi_payee_name: 60,
  support_phone: 20,
  turf_rules: 800,
  handoff_message: 300,
};

export function registerSettings(r: Router) {
  r.get('/settings', (req, res) => {
    const s = getAllSettings();
    const field = (key: SettingKey, label: string, hint = '', type = 'text') =>
      html`<label>${label}${hint ? html` <span class="hint">${hint}</span>` : ''}<input type="${type}" name="${key}" value="${s[key]}" ${NUMERIC[key] ? html`min="${NUMERIC[key]![0]}" max="${NUMERIC[key]![1]}"` : ''}></label>`;
    const area = (key: SettingKey, label: string, hint = '') =>
      html`<label class="full">${label}${hint ? html` <span class="hint">${hint}</span>` : ''}<textarea name="${key}">${s[key]}</textarea></label>`;
    const admins = all<{ id: number; username: string; last_login_at: number | null }>('SELECT id, username, last_login_at FROM admins ORDER BY id');
    const auditRows = all<{ action: string; details: string; created_at: number; username: string | null }>(
      'SELECT l.action, l.details, l.created_at, a.username FROM audit_log l LEFT JOIN admins a ON a.id = l.admin_id ORDER BY l.id DESC LIMIT 40',
    );
    const webhook = `${config.publicBaseUrl}/webhooks/whatsapp`;
    res.send(
      page(req, 'Settings', [
        html`<form method="post" action="/admin/settings" class="card">${csrfField(req)}
          <fieldset><legend>Business</legend><div class="form-grid">
            ${field('business_name', 'Business name')}
            ${field('support_phone', 'Support phone', '(shown when customers ask for a human)')}
            ${area('welcome_message', 'Welcome message', '(shown after "Hi <name>! Welcome to …")')}
            ${area('turf_rules', 'Turf rules', '(sent with confirmations and in the help menu)')}
            ${area('handoff_message', 'Human hand-off message')}
          </div></fieldset>
          <fieldset><legend>Payments</legend><div class="form-grid">
            ${field('upi_vpa', 'UPI ID (VPA)', 'e.g. playzone@okaxis')}
            ${field('upi_payee_name', 'UPI payee name')}
            ${field('hold_minutes', 'Hold unpaid slots for', '(minutes)', 'number')}
            <label class="check full"><input type="checkbox" name="allow_advance_payment" ${s.allow_advance_payment === 'true' ? 'checked' : ''}> Allow advance (partial) payments — uses each turf's advance %</label>
            <div class="full small muted">Razorpay (automatic verification): ${razorpayEnabled() ? badge('connected', 'green') : badge('not configured', 'grey')} — set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET in .env. Without Razorpay, customers pay by UPI and you verify their UTR on the Payments page.</div>
          </div></fieldset>
          <fieldset><legend>Booking rules</legend><div class="form-grid">
            ${field('booking_window_days', 'Bookable days ahead', '', 'number')}
            ${field('min_lead_minutes', 'Minimum notice', '(minutes before slot)', 'number')}
            ${field('reminder_hours_before', 'Send reminder', '(hours before; 0 = off)', 'number')}
          </div></fieldset>
          <fieldset><legend>Cancellation & rescheduling</legend><div class="form-grid">
            ${field('free_cancel_hours', 'Full refund if cancelled', '(hours before)', 'number')}
            ${field('late_cancel_refund_percent', 'Late cancellation refund', '(%)', 'number')}
            ${field('cancel_cutoff_hours', 'No cancellations within', '(hours)', 'number')}
            ${field('reschedule_cutoff_hours', 'Reschedule allowed until', '(hours before)', 'number')}
            ${field('max_reschedules', 'Max reschedules per booking', '', 'number')}
          </div></fieldset>
          <button class="btn primary">Save settings</button>
        </form>

        <div class="card"><h2>WhatsApp connection</h2><dl class="kv">
          <dt>Mode</dt><dd>${config.whatsapp.mode === 'cloud' ? badge('WhatsApp Cloud API', 'green') : badge('mock (simulator only)', 'amber')}</dd>
          <dt>Webhook URL</dt><dd class="mono">${webhook}</dd>
          <dt>Verify token</dt><dd>${config.whatsapp.verifyToken ? 'set in .env (WHATSAPP_VERIFY_TOKEN)' : badge('missing', 'red')}</dd>
          <dt>Signature check</dt><dd>${config.whatsapp.appSecret ? badge('enabled', 'green') : badge('WHATSAPP_APP_SECRET not set', 'red')}</dd>
          <dt>Reminder template</dt><dd>${config.whatsapp.reminderTemplate || html`<span class="muted">none — reminders only reach customers who messaged in the last 24h</span>`}</dd>
          <dt>Admin alert numbers</dt><dd>${config.adminNumbers.join(', ') || html`<span class="muted">none (ADMIN_WHATSAPP_NUMBERS)</span>`}</dd>
        </dl></div>

        <div class="grid k2">
          <form method="post" action="/admin/account/password" class="card">${csrfField(req)}<h2>Change your password</h2>
            <label>Current password<input type="password" name="current" required autocomplete="current-password"></label>
            <label>New password <span class="hint">(10+ chars, letters & numbers)</span><input type="password" name="password" required autocomplete="new-password"></label>
            <label>Repeat new password<input type="password" name="confirm" required autocomplete="new-password"></label>
            <button class="btn primary">Update password</button>
          </form>
          <form method="post" action="/admin/account/new" class="card">${csrfField(req)}<h2>Admins</h2>
            <table><tbody>${admins.map((a) => html`<tr><td>${a.username}</td><td class="small muted">${a.last_login_at ? `last login ${formatDateTime(a.last_login_at)}` : 'never signed in'}</td></tr>`)}</tbody></table>
            <h3 style="margin-top:14px">Add admin</h3>
            <label>Username<input name="username" required pattern="[A-Za-z0-9_.-]{3,32}"></label>
            <label>Password<input type="password" name="password" required autocomplete="new-password"></label>
            <button class="btn">Add admin</button>
          </form>
        </div>
        <div class="section-gap"></div>
        <div class="card tight"><h2>Activity log</h2>
          <table><thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Details</th></tr></thead><tbody>
          ${auditRows.map((a) => html`<tr><td class="small nowrap">${formatDateTime(a.created_at)}</td><td>${a.username ?? '—'}</td><td class="mono small">${a.action}</td><td class="small">${a.details}</td></tr>`)}
          </tbody></table>
        </div>`,
      ]),
    );
  });

  r.post('/settings', (req, res) => {
    const b = body(req);
    const values: Partial<Record<SettingKey, string>> = {};
    for (const [key, max] of Object.entries(TEXT_LIMITS) as [SettingKey, number][]) values[key] = str(b[key], max);
    for (const [key, [min, max]] of Object.entries(NUMERIC) as [SettingKey, [number, number]][]) {
      const n = Number(b[key]);
      if (!Number.isFinite(n) || n < min || n > max) return back(req, res, '/admin/settings', 'err', `${key.replace(/_/g, ' ')} must be between ${min} and ${max}.`);
      values[key] = String(Math.round(n));
    }
    if (values.upi_vpa && !/^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/.test(values.upi_vpa)) {
      return back(req, res, '/admin/settings', 'err', 'UPI ID should look like name@bank.');
    }
    if (!values.business_name) return back(req, res, '/admin/settings', 'err', 'Business name is required.');
    values.allow_advance_payment = checked(b.allow_advance_payment) ? 'true' : 'false';
    setSettings(values);
    audit(req.admin!.id, 'settings.update');
    back(req, res, '/admin/settings', 'ok', 'Settings saved.');
  });

  r.post('/account/password', (req, res) => {
    const b = body(req);
    const row = get<{ password_hash: string }>('SELECT password_hash FROM admins WHERE id = ?', req.admin!.id)!;
    if (!verifyPassword(String(b.current ?? ''), row.password_hash)) return back(req, res, '/admin/settings', 'err', 'Current password is incorrect.');
    const pw = String(b.password ?? '');
    if (pw !== String(b.confirm ?? '')) return back(req, res, '/admin/settings', 'err', 'New passwords do not match.');
    const problem = passwordProblems(pw);
    if (problem) return back(req, res, '/admin/settings', 'err', problem);
    setAdminPassword(req.admin!.id, pw);
    audit(req.admin!.id, 'account.password');
    res.redirect(303, '/admin/login?changed=1');
  });

  r.post('/account/new', (req, res) => {
    const b = body(req);
    const username = str(b.username, 32);
    const pw = String(b.password ?? '');
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return back(req, res, '/admin/settings', 'err', 'Username must be 3–32 letters, numbers, dots, dashes or underscores.');
    const problem = passwordProblems(pw);
    if (problem) return back(req, res, '/admin/settings', 'err', problem);
    if (get('SELECT 1 FROM admins WHERE username = ?', username)) return back(req, res, '/admin/settings', 'err', 'That username is taken.');
    createAdmin(username, pw);
    audit(req.admin!.id, 'account.create', username);
    back(req, res, '/admin/settings', 'ok', `Admin ${username} added.`);
  });
}
