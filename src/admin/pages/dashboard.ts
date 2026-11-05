import type { Router } from 'express';
import { listBookings } from '../../services/bookings.js';
import { attentionCounts, byTurf, dailySeries, revenueSummary, summaryForRange, type PeriodSummary } from '../../services/reports.js';
import { displayPhone, rupees } from '../../utils/misc.js';
import { addDays, formatDate, formatDateLong, formatRange, isValidDate, today } from '../../utils/time.js';
import { html, raw } from '../html.js';
import { empty, page, statusBadge } from '../layout.js';

function kpi(label: string, value: string, sub: string, alert = false) {
  return html`<div class="card kpi ${alert ? 'alert' : ''}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
}

function periodKpi(p: PeriodSummary) {
  return kpi(
    `${p.label} — collected`,
    rupees(p.net),
    `${p.bookings} booking${p.bookings === 1 ? '' : 's'} · ${p.hours} hrs · booked value ${rupees(p.bookedValue)}${p.refunded ? ` · refunds ${rupees(p.refunded)}` : ''}`,
  );
}

export function bars(series: { date: string; net: number; booked: number }[], key: 'net' | 'booked' = 'net') {
  const max = Math.max(1, ...series.map((d) => d[key]));
  return html`<div class="bars">
    ${series.map(
      (d) =>
        html`<div class="bar" title="${formatDate(d.date)}: ${rupees(d[key])}"><span style="height:${raw(String(Math.round((d[key] / max) * 100)))}%"></span><small>${d.date.slice(8)}</small></div>`,
    )}
  </div>`;
}

function bookingRows(rows: ReturnType<typeof listBookings>) {
  return html`<div class="table-wrap"><table>
    <thead><tr><th>Time</th><th>Turf</th><th>Customer</th><th>Status</th><th>Payment</th><th class="right">Amount</th><th></th></tr></thead>
    <tbody>
      ${rows.map(
        (b) => html`<tr>
          <td class="nowrap"><b>${formatRange(b.start_minute, b.end_minute)}</b><div class="small muted">${formatDate(b.date)}</div></td>
          <td>${b.turf_name}<div class="small muted">${b.location_name}</div></td>
          <td>${b.contact_name}<div class="small muted">${displayPhone(b.contact_phone)}</div></td>
          <td>${statusBadge(b.status)}</td>
          <td>${statusBadge(b.payment_status)}</td>
          <td class="right nowrap">${rupees(b.total_amount)}<div class="small muted">paid ${rupees(b.amount_paid)}</div></td>
          <td class="actions"><a class="btn sm" href="/admin/bookings/${b.id}">Open</a></td>
        </tr>`,
      )}
    </tbody></table></div>`;
}

export function registerDashboard(r: Router) {
  r.get('/', (req, res) => {
    const t = today();
    const s = revenueSummary();
    const a = attentionCounts();
    const todays = listBookings({ date: t })
      .filter((b) => ['pending_payment', 'confirmed', 'completed', 'no_show'].includes(b.status))
      .sort((x, y) => x.start_minute - y.start_minute || x.turf_name.localeCompare(y.turf_name));
    const tomorrow = listBookings({ date: addDays(t, 1), status: 'active' }).sort((x, y) => x.start_minute - y.start_minute);
    const series = dailySeries(addDays(t, -13), t);
    const turfs = byTurf(`${t.slice(0, 8)}01`, t);

    const attention = [
      a.pendingVerifications && html`<a class="card kpi alert" href="/admin/payments"><div class="label">Payments to verify</div><div class="value">${a.pendingVerifications}</div><div class="sub">Customers say they paid — verify now →</div></a>`,
      a.humanHandoffs && html`<a class="card kpi alert" href="/admin/inbox"><div class="label">Chats waiting for you</div><div class="value">${a.humanHandoffs}</div><div class="sub">Customers asked for a human →</div></a>`,
      a.refundsPending && html`<a class="card kpi alert" href="/admin/bookings?payment=refund_pending"><div class="label">Refunds pending</div><div class="value">${a.refundsPending}</div><div class="sub">Process and mark as refunded →</div></a>`,
      a.holds && html`<a class="card kpi" href="/admin/bookings?status=pending_payment"><div class="label">Unpaid holds</div><div class="value">${a.holds}</div><div class="sub">Awaiting customer payment</div></a>`,
    ].filter(Boolean);

    res.send(
      page(req, 'Dashboard', [
        html`<div class="grid k4">
          ${periodKpi(s.today)}${periodKpi(s.week)}${periodKpi(s.month)}
          ${kpi('Today — bookings', String(todays.filter((b) => b.status !== 'pending_payment').length), `${todays.filter((b) => b.status === 'pending_payment').length} awaiting payment`)}
        </div>
        <div class="section-gap"></div>`,
        attention.length ? html`<div class="grid k4">${attention}</div><div class="section-gap"></div>` : html``,
        html`<div class="card tight">
          <h2>Today · ${formatDateLong(t)}</h2>
          ${todays.length ? bookingRows(todays) : empty('No bookings today yet.')}
        </div>
        <div class="grid k2">
          <div class="card"><h2>Collections · last 14 days</h2>${bars(series)}<p class="small muted">Net of refunds, by payment date.</p></div>
          <div class="card tight"><h2>This month by turf</h2>
            <table><thead><tr><th>Turf</th><th class="right">Bookings</th><th class="right">Hours</th><th class="right">Value</th></tr></thead>
            <tbody>${turfs.map((x) => html`<tr><td>${x.turf_name}<div class="small muted">${x.location_name}</div></td><td class="right">${x.bookings}</td><td class="right">${Math.round(x.hours * 10) / 10}</td><td class="right">${rupees(x.value)}</td></tr>`)}</tbody></table>
          </div>
        </div>
        <div class="section-gap"></div>
        <div class="card tight"><h2>Tomorrow · ${formatDateLong(addDays(t, 1))}</h2>${tomorrow.length ? bookingRows(tomorrow) : empty('No bookings tomorrow yet.')}</div>`,
      ]),
    );
  });

  r.get('/reports', (req, res) => {
    const t = today();
    let from = String(req.query.from ?? '');
    let to = String(req.query.to ?? '');
    if (!isValidDate(from)) from = `${t.slice(0, 8)}01`;
    if (!isValidDate(to)) to = t;
    if (from > to) [from, to] = [to, from];
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (days > 366) from = addDays(to, -366);
    const s = summaryForRange(from, to);
    const series = dailySeries(from, to);
    const turfs = byTurf(from, to);
    const preset = (label: string, f: string, tt: string) => html`<a class="btn sm" href="/admin/reports?from=${f}&to=${tt}">${label}</a>`;
    const dow = (new Date(t + 'T00:00:00Z').getUTCDay() + 6) % 7;
    res.send(
      page(req, 'Revenue reports', [
        html`<form class="card filters" method="get">
          <label>From<input type="date" name="from" value="${from}"></label>
          <label>To<input type="date" name="to" value="${to}"></label>
          <button class="btn primary">Apply</button>
          <span class="row">${preset('Today', t, t)}${preset('This week', addDays(t, -dow), t)}${preset('This month', `${t.slice(0, 8)}01`, t)}${preset('Last 30 days', addDays(t, -29), t)}</span>
          <a class="btn" href="/admin/reports.csv?from=${from}&to=${to}">⬇ Export bookings CSV</a>
        </form>
        <div class="grid k4">
          ${kpi('Collected (net)', rupees(s.net), `gross ${rupees(s.collected)} · refunds ${rupees(s.refunded)}`)}
          ${kpi('Booked value', rupees(s.bookedValue), 'confirmed + completed bookings by play date')}
          ${kpi('Bookings', String(s.bookings), `${s.hours} hours played/booked`)}
          ${kpi('Avg. per booking', rupees(s.bookings ? s.bookedValue / s.bookings : 0), 'booked value ÷ bookings')}
        </div>
        <div class="section-gap"></div>
        <div class="card"><h2>Daily collections</h2>${bars(series)}</div>
        <div class="grid k2">
          <div class="card tight"><h2>By turf</h2>
            <table><thead><tr><th>Turf</th><th class="right">Bookings</th><th class="right">Hours</th><th class="right">Value</th><th class="right">Paid</th></tr></thead>
            <tbody>${turfs.map((x) => html`<tr><td>${x.turf_name}<div class="small muted">${x.location_name}</div></td><td class="right">${x.bookings}</td><td class="right">${Math.round(x.hours * 10) / 10}</td><td class="right">${rupees(x.value)}</td><td class="right">${rupees(x.paid)}</td></tr>`)}</tbody></table>
          </div>
          <div class="card tight"><h2>By day</h2><div class="table-wrap" style="max-height:420px">
            <table><thead><tr><th>Date</th><th class="right">Bookings</th><th class="right">Booked value</th><th class="right">Collected</th></tr></thead>
            <tbody>${[...series].reverse().map((d) => html`<tr><td>${formatDate(d.date)}</td><td class="right">${d.bookings}</td><td class="right">${rupees(d.booked)}</td><td class="right">${rupees(d.net)}</td></tr>`)}</tbody></table>
          </div></div>
        </div>`,
      ]),
    );
  });

  r.get('/reports.csv', (req, res) => {
    const from = isValidDate(String(req.query.from)) ? String(req.query.from) : today();
    const to = isValidDate(String(req.query.to)) ? String(req.query.to) : today();
    const rows = listBookings({ from, to, limit: 10_000 });
    const cell = (v: unknown) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
      return `"${s.replace(/"/g, '""')}"`;
    };
    const header = ['Booking ID', 'Date', 'Start', 'End', 'Turf', 'Location', 'Name', 'Phone', 'Status', 'Payment status', 'Total', 'Discount', 'Paid', 'Refund', 'Offer', 'Source', 'Created'];
    const lines = [header.map(cell).join(',')];
    for (const b of rows) {
      const [s, e] = formatRange(b.start_minute, b.end_minute).split(' – ');
      lines.push(
        [b.code, b.date, s, e, b.turf_name, b.location_name, b.contact_name, b.contact_phone, b.status, b.payment_status, b.total_amount, b.discount_amount, b.amount_paid, b.refund_amount, b.offer_title, b.source, new Date(b.created_at).toISOString()]
          .map(cell)
          .join(','),
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bookings_${from}_${to}.csv"`);
    res.send('﻿' + lines.join('\r\n'));
  });
}
