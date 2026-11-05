import type { Router } from 'express';
import { all, get, run } from '../../db/index.js';
import { afterPayment, sendBookingConfirmed, sendCancelledByAdmin, sendPaymentInstructions, sendPaymentRejected, sendRefundProcessed, sendRescheduledByAdmin } from '../../bot/notify.js';
import { isRangeBookable } from '../../services/availability.js';
import {
  BookingError,
  cancelBooking,
  createBooking,
  getBooking,
  listBookings,
  listPaymentsForBooking,
  markRefunded,
  pendingClaims,
  recordPayment,
  rejectPaymentClaim,
  rescheduleBooking,
  setBookingStatus,
} from '../../services/bookings.js';
import { getTurf, listTurfs } from '../../services/catalog.js';
import { upsertCustomer } from '../../services/customers.js';
import { amountDue } from '../../services/payments.js';
import { quote } from '../../services/pricing.js';
import type { Payment } from '../../types.js';
import { displayPhone, normalizePhone, rupees } from '../../utils/misc.js';
import { durationLabel, formatDate, formatDateLong, formatDateTime, formatRange, isValidDate, today } from '../../utils/time.js';
import { audit } from '../auth.js';
import { html } from '../html.js';
import { back, body, checked, csrfField, empty, int, page, statusBadge, str } from '../layout.js';

const STATUSES = ['active', 'pending_payment', 'confirmed', 'completed', 'cancelled', 'expired', 'no_show'];
const PAYMENT_STATUSES = ['unpaid', 'verification_pending', 'advance_paid', 'paid', 'refund_pending', 'refunded'];
const METHODS = ['cash', 'upi', 'card', 'bank_transfer', 'other'];

function opt(value: string, label: string, selected: unknown) {
  return html`<option value="${value}" ${String(selected) === value ? 'selected' : ''}>${label}</option>`;
}

/** Start times on a date at which `slots` consecutive slots are bookable. */
function bookableStarts(turfId: number, date: string, slots: number, excludeBookingId?: number) {
  const turf = getTurf(turfId);
  if (!turf || !isValidDate(date)) return [];
  const out: number[] = [];
  const duration = slots * turf.slot_minutes;
  for (let s = turf.open_minute; s + duration <= turf.close_minute; s += turf.slot_minutes) {
    if (isRangeBookable(turf, date, s, s + duration, { excludeBookingId, ignoreLeadTime: true }).ok) out.push(s);
  }
  return out;
}

export function registerBookings(r: Router) {
  /* ------------------------------- List ------------------------------- */
  r.get('/bookings', (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const f = {
      search: q.q ?? '',
      status: STATUSES.includes(q.status ?? '') ? q.status : undefined,
      paymentStatus: PAYMENT_STATUSES.includes(q.payment ?? '') ? q.payment : undefined,
      date: isValidDate(q.date ?? '') ? q.date : undefined,
      from: isValidDate(q.from ?? '') ? q.from : undefined,
      to: isValidDate(q.to ?? '') ? q.to : undefined,
      turfId: q.turf ? Number(q.turf) : undefined,
    };
    const rows = listBookings(f);
    const turfs = listTurfs();
    res.send(
      page(req, 'Bookings', [
        html`<form class="card filters" method="get">
          <label>Search<input name="q" value="${f.search}" placeholder="ID, name or phone"></label>
          <label>Status<select name="status"><option value="">All</option>${STATUSES.map((s) => opt(s, s.replace(/_/g, ' '), f.status))}</select></label>
          <label>Payment<select name="payment"><option value="">All</option>${PAYMENT_STATUSES.map((s) => opt(s, s.replace(/_/g, ' '), f.paymentStatus))}</select></label>
          <label>Turf<select name="turf"><option value="">All</option>${turfs.map((t) => opt(String(t.id), t.name, f.turfId))}</select></label>
          <label>From<input type="date" name="from" value="${f.from ?? ''}"></label>
          <label>To<input type="date" name="to" value="${f.to ?? ''}"></label>
          <button class="btn primary">Filter</button>
          <a class="btn" href="/admin/bookings">Reset</a>
          <a class="btn primary" style="margin-left:auto" href="/admin/bookings/new">＋ New booking</a>
        </form>
        <div class="card tight">
          ${
            rows.length
              ? html`<div class="table-wrap"><table>
              <thead><tr><th>ID</th><th>When</th><th>Turf</th><th>Customer</th><th>Status</th><th>Payment</th><th class="right">Total</th><th class="right">Paid</th><th></th></tr></thead>
              <tbody>${rows.map(
                (b) => html`<tr>
                  <td class="mono"><a href="/admin/bookings/${b.id}">${b.code}</a><div class="small muted">${b.source}</div></td>
                  <td class="nowrap">${formatDate(b.date)}<div class="small muted">${formatRange(b.start_minute, b.end_minute)}</div></td>
                  <td>${b.turf_name}<div class="small muted">${b.location_name}</div></td>
                  <td>${b.contact_name}<div class="small muted">${displayPhone(b.contact_phone)}</div></td>
                  <td>${statusBadge(b.status)}</td><td>${statusBadge(b.payment_status)}</td>
                  <td class="right">${rupees(b.total_amount)}</td><td class="right">${rupees(b.amount_paid)}</td>
                  <td class="actions"><a class="btn sm" href="/admin/bookings/${b.id}">Open</a></td>
                </tr>`,
              )}</tbody></table></div>
              <p class="small muted" style="padding:0 18px">${rows.length} booking(s)${rows.length >= 300 ? ' — showing the latest 300, refine filters to see more' : ''}</p>`
              : empty('No bookings match these filters.')
          }
        </div>`,
      ]),
    );
  });

  /* ------------------------------ Create ------------------------------ */
  r.get('/bookings/new', (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const turfs = listTurfs({ activeOnly: true });
    const turfId = Number(q.turf ?? turfs[0]?.id ?? 0);
    const date = isValidDate(q.date ?? '') ? q.date! : today();
    const slots = Math.max(1, Math.min(12, int(q.slots, 1)));
    const turf = getTurf(turfId);
    const starts = turf ? bookableStarts(turfId, date, slots) : [];
    res.send(
      page(req, 'New booking', [
        html`<form class="card filters" method="get">
          <label>Turf<select name="turf">${turfs.map((t) => opt(String(t.id), `${t.name} (${t.location_name})`, turfId))}</select></label>
          <label>Date<input type="date" name="date" value="${date}"></label>
          <label>Slots<input type="number" name="slots" min="1" max="12" value="${slots}"></label>
          <button class="btn">Show free times</button>
        </form>
        ${
          !turf
            ? empty('Create a turf first.')
            : html`<form class="card" method="post" action="/admin/bookings">
          ${csrfField(req)}
          <input type="hidden" name="turf_id" value="${turfId}"><input type="hidden" name="date" value="${date}"><input type="hidden" name="slots" value="${slots}">
          <h2>${turf.name} · ${formatDateLong(date)} · ${durationLabel(slots * turf.slot_minutes)}</h2>
          ${
            starts.length === 0
              ? empty('No free times for this duration on that date.')
              : html`<div class="form-grid">
            <label>Start time<select name="start" required>${starts.map((s) => {
              const qt = quote(turf, date, s, slots);
              return html`<option value="${s}">${formatRange(s, s + slots * turf.slot_minutes)} — ${rupees(qt.total)}${qt.offer ? ` (${qt.offer.title})` : ''}</option>`;
            })}</select></label>
            <label>Customer name<input name="name" required maxlength="60"></label>
            <label>Mobile number<input name="phone" required placeholder="9876543210"></label>
            <label>Payment option<select name="payment_option"><option value="full">Full</option><option value="advance">Advance (${turf.advance_percent}%)</option></select></label>
            <label>Amount received now <span class="hint">(₹, optional)</span><input type="number" name="paid" min="0" value="0"></label>
            <label>Payment method<select name="method">${METHODS.map((m) => opt(m, m.replace('_', ' '), 'cash'))}</select></label>
            <label class="full">Notes<input name="notes" maxlength="300" placeholder="e.g. phone booking, corporate event"></label>
            <label class="check full"><input type="checkbox" name="confirm_now" checked> Confirm now (customer pays at venue if not paid)</label>
            <label class="check full"><input type="checkbox" name="notify" checked> Send WhatsApp confirmation to the customer</label>
          </div>
          <button class="btn primary">Create booking</button>`
          }
        </form>`
        }`,
      ]),
    );
  });

  r.post('/bookings', async (req, res) => {
    const b = body(req);
    const phone = normalizePhone(str(b.phone));
    const name = str(b.name, 60);
    if (!phone || !name) return back(req, res, '/admin/bookings/new', 'err', 'A valid name and mobile number are required.');
    try {
      const customer = upsertCustomer(phone);
      if (!customer.name) run('UPDATE customers SET name = ? WHERE id = ?', name, customer.id);
      let booking = createBooking({
        turfId: int(b.turf_id),
        customerId: customer.id,
        date: str(b.date),
        startMinute: int(b.start),
        slots: int(b.slots, 1),
        contactName: name,
        contactPhone: phone,
        paymentOption: str(b.payment_option) === 'advance' ? 'advance' : 'full',
        source: 'admin',
        confirmNow: checked(b.confirm_now),
        notes: str(b.notes, 300),
      });
      const paid = int(b.paid);
      if (paid > 0) {
        booking = recordPayment(booking.id, { amount: paid, method: str(b.method) || 'cash', verifiedBy: req.admin!.id, note: 'Recorded at booking' }).booking;
      }
      audit(req.admin!.id, 'booking.create', `${booking.code} paid=${paid}`);
      if (checked(b.notify)) {
        if (booking.status === 'confirmed') await sendBookingConfirmed(booking);
        else await sendPaymentInstructions(booking.customer_phone, booking);
      }
      back(req, res, `/admin/bookings/${booking.id}`, 'ok', `Booking ${booking.code} created.`);
    } catch (err) {
      if (err instanceof BookingError) return back(req, res, '/admin/bookings/new', 'err', err.message);
      throw err;
    }
  });

  /* ------------------------------ Detail ------------------------------ */
  r.get('/bookings/:id', (req, res) => {
    const b = getBooking(Number(req.params.id));
    if (!b) {
      res.status(404).send(page(req, 'Not found', empty('Booking not found.')));
      return;
    }
    const payments = listPaymentsForBooking(b.id);
    const due = amountDue(b);
    const active = b.status === 'pending_payment' || b.status === 'confirmed';
    const rsDate = isValidDate(String(req.query.rsdate ?? '')) ? String(req.query.rsdate) : b.date;
    const slotsCount = Math.max(1, Math.round((b.end_minute - b.start_minute) / b.slot_minutes));
    const rsStarts = active ? bookableStarts(b.turf_id, rsDate, slotsCount, b.id) : [];
    const customerId = b.customer_id;

    res.send(
      page(req, `Booking ${b.code}`, [
        html`<div class="grid k2">
          <div class="card">
            <div class="row between"><h2>${b.turf_name} · ${b.location_name}</h2><span>${statusBadge(b.status)} ${statusBadge(b.payment_status)}</span></div>
            <dl class="kv">
              <dt>Date</dt><dd>${formatDateLong(b.date)}</dd>
              <dt>Time</dt><dd>${formatRange(b.start_minute, b.end_minute)} (${durationLabel(b.end_minute - b.start_minute)})</dd>
              <dt>Customer</dt><dd>${b.contact_name} · ${displayPhone(b.contact_phone)} <a class="small" href="/admin/customers/${customerId}">profile</a></dd>
              <dt>WhatsApp</dt><dd>${displayPhone(b.customer_phone)} <a class="small" href="/admin/inbox/${b.customer_phone}">open chat</a></dd>
              <dt>Price</dt><dd>${rupees(b.total_amount)}${b.discount_amount ? html` <span class="muted">(${rupees(b.gross_amount)} − ${rupees(b.discount_amount)} ${b.offer_title})</span>` : ''}</dd>
              <dt>Payment option</dt><dd>${b.payment_option} · required to confirm ${rupees(b.amount_required)}</dd>
              <dt>Paid</dt><dd>${rupees(b.amount_paid)}${b.total_amount - b.amount_paid > 0 ? html` · <b>balance ${rupees(b.total_amount - b.amount_paid)}</b>` : ''}</dd>
              ${b.hold_expires_at && b.status === 'pending_payment' ? html`<dt>Hold expires</dt><dd>${formatDateTime(b.hold_expires_at)}</dd>` : ''}
              ${b.status === 'cancelled' ? html`<dt>Cancelled</dt><dd>${b.cancelled_at ? formatDateTime(b.cancelled_at) : ''} — ${b.cancel_reason}</dd><dt>Refund</dt><dd>${rupees(b.refund_amount)}</dd>` : ''}
              <dt>Rescheduled</dt><dd>${b.reschedule_count} time(s)</dd>
              <dt>Created</dt><dd>${formatDateTime(b.created_at)} via ${b.source}</dd>
            </dl>
            <form method="post" action="/admin/bookings/${b.id}/notes" style="margin-top:14px">${csrfField(req)}
              <label>Internal notes<textarea name="notes" maxlength="1000">${b.notes}</textarea></label>
              <button class="btn sm">Save notes</button>
            </form>
          </div>
          <div class="card">
            <h2>Payments</h2>
            ${
              payments.length
                ? html`<table><thead><tr><th>When</th><th>Method</th><th>Ref</th><th>Status</th><th class="right">Amount</th></tr></thead><tbody>
                ${payments.map((p: Payment) => html`<tr><td class="small">${formatDateTime(p.created_at)}</td><td>${p.method}</td><td class="mono small">${p.reference}${p.note ? html`<div class="muted">${p.note}</div>` : ''}</td><td>${statusBadge(p.status === 'success' ? 'paid' : p.status === 'pending' ? 'verification_pending' : p.status)}</td><td class="right">${p.method === 'refund' ? '−' : ''}${rupees(p.amount)}</td></tr>`)}
              </tbody></table>`
                : empty('No payments yet.')
            }
            ${
              b.status !== 'cancelled' && b.status !== 'expired' && b.total_amount - b.amount_paid > 0
                ? html`<form method="post" action="/admin/bookings/${b.id}/payment" class="form-grid" style="margin-top:14px">${csrfField(req)}
                <label>Amount (₹)<input type="number" name="amount" min="1" value="${due || b.total_amount - b.amount_paid}" required></label>
                <label>Method<select name="method">${METHODS.map((m) => opt(m, m.replace('_', ' '), 'upi'))}</select></label>
                <label>Reference<input name="reference" placeholder="UTR / receipt no."></label>
                <label class="check full"><input type="checkbox" name="notify" checked> Notify customer on WhatsApp</label>
                <div class="full"><button class="btn primary">Record payment</button></div>
              </form>`
                : ''
            }
            ${
              b.payment_status === 'refund_pending'
                ? html`<form method="post" action="/admin/bookings/${b.id}/refunded" class="row" style="margin-top:14px">${csrfField(req)}
                <input name="reference" placeholder="Refund reference" style="max-width:220px">
                <button class="btn primary">Mark ${rupees(b.refund_amount)} refunded</button></form>`
                : ''
            }
            ${b.status === 'pending_payment' ? html`<form method="post" action="/admin/bookings/${b.id}/resend" style="margin-top:10px">${csrfField(req)}<button class="btn sm">Resend payment instructions on WhatsApp</button></form>` : ''}
          </div>
        </div>
        <div class="section-gap"></div>`,
        active
          ? html`<div class="grid k3">
          <div class="card"><h2>Reschedule</h2>
            <form method="get" class="row"><input type="date" name="rsdate" value="${rsDate}" style="max-width:180px"><button class="btn sm">Show times</button></form>
            <form method="post" action="/admin/bookings/${b.id}/reschedule" style="margin-top:10px">${csrfField(req)}
              <input type="hidden" name="date" value="${rsDate}">
              ${
                rsStarts.length
                  ? html`<label>New time on ${formatDate(rsDate)}<select name="start">${rsStarts.map((s) => html`<option value="${s}">${formatRange(s, s + (b.end_minute - b.start_minute))}</option>`)}</select></label>
                <label class="check"><input type="checkbox" name="notify" checked> Notify customer</label>
                <button class="btn">Move booking</button>`
                  : html`<p class="muted">No free times on ${formatDate(rsDate)}.</p>`
              }
            </form>
          </div>
          <div class="card"><h2>Cancel booking</h2>
            <form method="post" action="/admin/bookings/${b.id}/cancel">${csrfField(req)}
              <label>Reason<input name="reason" maxlength="200" placeholder="e.g. rain, maintenance"></label>
              <label>Refund amount (₹)<input type="number" name="refund" min="0" max="${b.amount_paid}" value="${b.amount_paid}"></label>
              <label class="check"><input type="checkbox" name="notify" checked> Notify customer</label>
              <button class="btn danger">Cancel booking</button>
            </form>
          </div>
          <div class="card"><h2>Status</h2><div class="stack">
            ${b.status === 'pending_payment' ? html`<form method="post" action="/admin/bookings/${b.id}/status">${csrfField(req)}<input type="hidden" name="status" value="confirmed"><label class="check"><input type="checkbox" name="notify" checked> Notify customer</label><button class="btn">Confirm without payment (pay at venue)</button></form>` : ''}
            ${b.status === 'confirmed' ? html`<form method="post" action="/admin/bookings/${b.id}/status">${csrfField(req)}<input type="hidden" name="status" value="completed"><button class="btn">Mark completed</button></form>
            <form method="post" action="/admin/bookings/${b.id}/status">${csrfField(req)}<input type="hidden" name="status" value="no_show"><button class="btn danger">Mark no-show</button></form>` : ''}
          </div></div>
        </div>`
          : html``,
      ]),
    );
  });

  r.post('/bookings/:id/notes', (req, res) => {
    run('UPDATE bookings SET notes = ?, updated_at = ? WHERE id = ?', str(body(req).notes, 1000), Date.now(), Number(req.params.id));
    back(req, res, `/admin/bookings/${req.params.id}`, 'ok', 'Notes saved.');
  });

  r.post('/bookings/:id/payment', async (req, res) => {
    const b = body(req);
    const id = Number(req.params.id);
    const amount = int(b.amount);
    try {
      const result = recordPayment(id, { amount, method: str(b.method, 30) || 'cash', reference: str(b.reference, 64), verifiedBy: req.admin!.id });
      audit(req.admin!.id, 'payment.record', `${result.booking.code} ₹${amount}`);
      if (checked(b.notify)) await afterPayment(result, amount);
      back(req, res, `/admin/bookings/${id}`, 'ok', result.conflict ? 'Payment recorded, but the slot was already taken — the booking was cancelled and marked for refund.' : `Payment of ${rupees(amount)} recorded.`);
    } catch (err) {
      if (err instanceof BookingError) return back(req, res, `/admin/bookings/${id}`, 'err', err.message);
      throw err;
    }
  });

  r.post('/bookings/:id/refunded', async (req, res) => {
    const id = Number(req.params.id);
    try {
      const b = markRefunded(id, req.admin!.id, str(body(req).reference, 64));
      audit(req.admin!.id, 'refund.mark', b.code);
      await sendRefundProcessed(b);
      back(req, res, `/admin/bookings/${id}`, 'ok', 'Refund marked as processed and customer notified.');
    } catch (err) {
      if (err instanceof BookingError) return back(req, res, `/admin/bookings/${id}`, 'err', err.message);
      throw err;
    }
  });

  r.post('/bookings/:id/resend', async (req, res) => {
    const b = getBooking(Number(req.params.id));
    if (b && b.status === 'pending_payment') await sendPaymentInstructions(b.customer_phone, b);
    back(req, res, `/admin/bookings/${req.params.id}`, 'ok', 'Payment instructions sent.');
  });

  r.post('/bookings/:id/cancel', async (req, res) => {
    const b = body(req);
    const id = Number(req.params.id);
    try {
      const reason = str(b.reason, 200);
      const c = cancelBooking(id, { by: 'admin', reason: reason || 'Cancelled by turf team', refundOverride: int(b.refund) });
      audit(req.admin!.id, 'booking.cancel', `${c.code} refund=${c.refund_amount}`);
      if (checked(b.notify)) await sendCancelledByAdmin(c, reason);
      back(req, res, `/admin/bookings/${id}`, 'ok', `Booking cancelled${c.refund_amount ? ` — refund of ${rupees(c.refund_amount)} pending` : ''}.`);
    } catch (err) {
      if (err instanceof BookingError) return back(req, res, `/admin/bookings/${id}`, 'err', err.message);
      throw err;
    }
  });

  r.post('/bookings/:id/reschedule', async (req, res) => {
    const b = body(req);
    const id = Number(req.params.id);
    try {
      const r2 = rescheduleBooking(id, str(b.date), int(b.start), 'admin');
      audit(req.admin!.id, 'booking.reschedule', `${r2.booking.code} → ${r2.booking.date} ${r2.booking.start_minute}`);
      if (checked(b.notify)) await sendRescheduledByAdmin(r2.booking);
      back(req, res, `/admin/bookings/${id}`, 'ok', `Moved to ${formatDate(r2.booking.date)} ${formatRange(r2.booking.start_minute, r2.booking.end_minute)}.`);
    } catch (err) {
      if (err instanceof BookingError) return back(req, res, `/admin/bookings/${id}`, 'err', err.message);
      throw err;
    }
  });

  r.post('/bookings/:id/status', async (req, res) => {
    const b = body(req);
    const id = Number(req.params.id);
    const status = str(b.status);
    const current = getBooking(id);
    if (!current || !['completed', 'no_show', 'confirmed'].includes(status)) return back(req, res, '/admin/bookings', 'err', 'Invalid status change.');
    const allowed = status === 'confirmed' ? current.status === 'pending_payment' : current.status === 'confirmed';
    if (!allowed) return back(req, res, `/admin/bookings/${id}`, 'err', 'That status change is not allowed for this booking.');
    if (status === 'confirmed') {
      const turf = getTurf(current.turf_id)!;
      const ok = isRangeBookable(turf, current.date, current.start_minute, current.end_minute, { excludeBookingId: id, ignoreLeadTime: true });
      if (!ok.ok) return back(req, res, `/admin/bookings/${id}`, 'err', ok.reason);
    }
    const updated = setBookingStatus(id, status as 'completed' | 'no_show' | 'confirmed');
    audit(req.admin!.id, 'booking.status', `${updated.code} → ${status}`);
    if (status === 'confirmed' && checked(b.notify)) await sendBookingConfirmed(updated);
    back(req, res, `/admin/bookings/${id}`, 'ok', `Booking marked ${status.replace('_', ' ')}.`);
  });

  /* ----------------------------- Payments ----------------------------- */
  r.get('/payments', (req, res) => {
    const claims = pendingClaims();
    const recent = all<Payment & { code: string; contact_name: string }>(
      `SELECT p.*, b.code, b.contact_name FROM payments p JOIN bookings b ON b.id = p.booking_id
        WHERE p.status <> 'pending' ORDER BY COALESCE(p.verified_at, p.created_at) DESC LIMIT 100`,
    );
    res.send(
      page(req, 'Payments', [
        html`<div class="card tight"><h2>Waiting for verification (${claims.length})</h2>
          <p class="muted" style="padding:0 18px">Customers who tapped “I’ve paid”. Check the amount and UTR in your bank/UPI app, then verify or reject.</p>
          ${
            claims.length
              ? html`<div class="table-wrap"><table><thead><tr><th>Booking</th><th>Slot</th><th>Customer</th><th>Reference</th><th>Claimed</th><th>Verify</th><th>Reject</th></tr></thead><tbody>
            ${claims.map((c) => {
              const media = c.reference.startsWith('screenshot:') ? c.reference.slice('screenshot:'.length) : '';
              return html`<tr>
                <td class="mono"><a href="/admin/bookings/${c.booking_id}">${c.code}</a></td>
                <td>${c.turf_name}<div class="small muted">${formatDate(c.date)} ${formatRange(c.start_minute, c.end_minute)}</div></td>
                <td>${c.contact_name}</td>
                <td class="mono">${media ? html`<a href="/admin/media/${media}" target="_blank" rel="noopener">View screenshot</a>` : c.reference || html`<span class="muted">none given</span>`}</td>
                <td class="small">${formatDateTime(c.created_at)}</td>
                <td><form method="post" action="/admin/payments/${c.id}/verify" class="row">${csrfField(req)}
                  <input type="number" name="amount" value="${c.amount}" min="1" style="width:100px;margin:0">
                  <button class="btn primary sm">✔ Verify</button></form></td>
                <td><form method="post" action="/admin/payments/${c.id}/reject" class="row">${csrfField(req)}
                  <input name="note" placeholder="Reason" style="width:140px;margin:0"><button class="btn danger sm">Reject</button></form></td>
              </tr>`;
            })}</tbody></table></div>`
              : empty('Nothing to verify. 🎉')
          }
        </div>
        <div class="card tight"><h2>Recent payments</h2>
          ${
            recent.length
              ? html`<div class="table-wrap"><table><thead><tr><th>When</th><th>Booking</th><th>Customer</th><th>Method</th><th>Reference</th><th>Status</th><th class="right">Amount</th></tr></thead><tbody>
            ${recent.map((p) => html`<tr><td class="small">${formatDateTime(p.verified_at ?? p.created_at)}</td><td class="mono"><a href="/admin/bookings/${p.booking_id}">${p.code}</a></td><td>${p.contact_name}</td><td>${p.method}</td><td class="mono small">${p.reference}</td><td>${statusBadge(p.status === 'success' ? 'paid' : p.status)}</td><td class="right">${p.method === 'refund' ? '−' : ''}${rupees(p.amount)}</td></tr>`)}
            </tbody></table></div>`
              : empty('No payments yet.')
          }
        </div>`,
      ]),
    );
  });

  r.post('/payments/:id/verify', async (req, res) => {
    const claim = get<Payment>("SELECT * FROM payments WHERE id = ? AND status = 'pending'", Number(req.params.id));
    if (!claim) return back(req, res, '/admin/payments', 'err', 'That payment claim was already handled.');
    const amount = int(body(req).amount, claim.amount);
    try {
      const result = recordPayment(claim.booking_id, { amount, method: 'upi', claimId: claim.id, verifiedBy: req.admin!.id });
      audit(req.admin!.id, 'payment.verify', `${result.booking.code} ₹${amount}`);
      await afterPayment(result, amount);
      back(req, res, '/admin/payments', 'ok', `Verified ${rupees(amount)} for ${result.booking.code}${result.confirmedNow ? ' — booking confirmed and customer notified' : ''}.`);
    } catch (err) {
      if (err instanceof BookingError) return back(req, res, '/admin/payments', 'err', err.message);
      throw err;
    }
  });

  r.post('/payments/:id/reject', async (req, res) => {
    const note = str(body(req).note, 200);
    try {
      const b = rejectPaymentClaim(Number(req.params.id), req.admin!.id, note);
      audit(req.admin!.id, 'payment.reject', `${b.code} ${note}`);
      await sendPaymentRejected(b, note);
      back(req, res, '/admin/payments', 'ok', `Payment claim for ${b.code} rejected; the customer was notified and the slot is held again for a short time.`);
    } catch (err) {
      if (err instanceof BookingError) return back(req, res, '/admin/payments', 'err', err.message);
      throw err;
    }
  });

}
