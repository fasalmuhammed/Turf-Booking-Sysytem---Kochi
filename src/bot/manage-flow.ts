import { availableDates, isRangeBookable, isWithinBookingWindow } from '../services/availability.js';
import {
  BookingError,
  cancelBooking,
  cancellationQuote,
  getBookingByCode,
  reviveHold,
  rescheduleBooking,
  rescheduleCheck,
  submitPaymentClaim,
  upcomingForCustomer,
  type BookingView,
} from '../services/bookings.js';
import { getTurf } from '../services/catalog.js';
import { amountDue } from '../services/payments.js';
import { quote } from '../services/pricing.js';
import { displayPhone, rupees, truncate } from '../utils/misc.js';
import { durationLabel, formatDate, formatDateLong, formatMinute, formatRange, isValidDate } from '../utils/time.js';
import { BOOK_BUTTON, HUMAN_BUTTON, MENU_BUTTON, paged, reply, text, type Ctx } from './context.js';
import { bookingDetailsText, locationLine, STATUS_LABEL } from './format.js';
import { adminBookingLine, notifyAdmins, sendPaymentInstructions } from './notify.js';

/** Loads a booking by code, but only if it belongs to the person messaging. */
async function ownBooking(ctx: Ctx, code: string): Promise<BookingView | null> {
  const b = getBookingByCode(code);
  if (!b || b.customer_id !== ctx.customer.id) {
    await reply(ctx, {
      kind: 'buttons',
      body: `🔍 I couldn't find booking *${code.toUpperCase()}* on this WhatsApp number.`,
      buttons: [{ id: 'mybk', title: '📋 My bookings' }, HUMAN_BUTTON],
    });
    return null;
  }
  return b;
}

/* ------------------------------ My bookings ----------------------------- */

export async function showMyBookings(ctx: Ctx) {
  ctx.session.state = 'my_bookings';
  const list = upcomingForCustomer(ctx.customer.id, ctx.nowMs);
  if (list.length === 0) {
    await reply(ctx, {
      kind: 'buttons',
      body: "📋 You don't have any upcoming bookings.\n\n_Tip: you can also type a booking ID (e.g. TB7K3Q9X) to look it up._",
      buttons: [BOOK_BUTTON, MENU_BUTTON],
    });
    return;
  }
  if (list.length === 1) return showBooking(ctx, list[0]!.code);
  const { rows } = paged(
    list,
    0,
    (b) => ({
      id: `bk:${b.code}`,
      title: truncate(`${formatDate(b.date)} ${formatMinute(b.start_minute)}`, 24),
      description: `${b.turf_name} · ${b.code} · ${(STATUS_LABEL[b.status] ?? b.status).replace(/^\S+\s/, '')}`,
    }),
    () => 'mybk',
  );
  await reply(ctx, {
    kind: 'list',
    body: `📋 You have *${list.length} upcoming bookings*. Pick one to view, pay, reschedule or cancel.`,
    button: 'View bookings',
    sections: [{ title: 'Upcoming', rows }],
  });
}

export async function showBooking(ctx: Ctx, code: string) {
  const b = await ownBooking(ctx, code);
  if (!b) return;
  ctx.session.state = 'idle';
  let body = bookingDetailsText(b);
  let buttons: { id: string; title: string }[];
  if (b.status === 'pending_payment' && b.payment_status === 'verification_pending') {
    body += '\n\n🔎 We are verifying your payment — you will get a confirmation here shortly.';
    buttons = [{ id: `cxl:${b.code}`, title: '❌ Cancel booking' }, HUMAN_BUTTON, MENU_BUTTON];
  } else if (b.status === 'pending_payment') {
    buttons = [
      { id: `pay:${b.code}`, title: '💳 Pay now' },
      { id: `paid:${b.code}`, title: '✅ I’ve paid' },
      { id: `cxl:${b.code}`, title: '❌ Cancel booking' },
    ];
  } else if (b.status === 'confirmed') {
    body += `\n\n${locationLine(b.location_id)}`;
    buttons = [
      { id: `rs:${b.code}`, title: '🔄 Reschedule' },
      { id: `cxl:${b.code}`, title: '❌ Cancel booking' },
      MENU_BUTTON,
    ];
  } else if (b.status === 'expired') {
    buttons = [{ id: `pay:${b.code}`, title: '🔁 Restore & pay' }, BOOK_BUTTON, MENU_BUTTON];
  } else {
    buttons = [BOOK_BUTTON, MENU_BUTTON];
  }
  await reply(ctx, { kind: 'buttons', body, buttons });
}

/* ------------------------------- Payments ------------------------------- */

export async function resendPayment(ctx: Ctx, code: string) {
  let b = await ownBooking(ctx, code);
  if (!b) return;
  if (b.status === 'expired') {
    b = reviveHold(b.id, ctx.nowMs);
    if (!b) {
      await reply(ctx, {
        kind: 'buttons',
        body: '😔 Sorry, that slot has been taken since your hold expired.',
        buttons: [BOOK_BUTTON, MENU_BUTTON],
      });
      return;
    }
    await text(ctx, `🔁 Good news — the slot is still free and is held for you again.`);
  }
  if (b.status !== 'pending_payment' && !(b.status === 'confirmed' && amountDue(b) > 0)) {
    await reply(ctx, { kind: 'buttons', body: `Booking *${b.code}* doesn't need any payment right now.\n\n${STATUS_LABEL[b.status]}`, buttons: [{ id: `bk:${b.code}`, title: '📋 View booking' }, MENU_BUTTON] });
    return;
  }
  ctx.session.state = 'awaiting_payment';
  ctx.session.data.bookingCode = b.code;
  await sendPaymentInstructions(ctx.phone, b);
}

export async function startPaymentClaim(ctx: Ctx, code: string) {
  const b = await ownBooking(ctx, code);
  if (!b) return;
  if (b.status === 'confirmed' && amountDue(b) === 0) {
    await reply(ctx, { kind: 'buttons', body: `✅ Booking *${b.code}* is already confirmed and fully paid.`, buttons: [{ id: `bk:${b.code}`, title: '📋 View booking' }, MENU_BUTTON] });
    return;
  }
  if (!['pending_payment', 'expired', 'confirmed'].includes(b.status)) {
    await reply(ctx, { kind: 'buttons', body: `Booking *${b.code}* is ${STATUS_LABEL[b.status]}. If you paid for it, please talk to our team.`, buttons: [HUMAN_BUTTON, MENU_BUTTON] });
    return;
  }
  ctx.session.state = 'enter_utr';
  ctx.session.data.bookingCode = b.code;
  await reply(ctx, {
    kind: 'buttons',
    body:
      `🧾 Please reply with the *UPI transaction ID / UTR* (12 digits, shown in your UPI app after paying) for *${b.code}*.\n\n` +
      `You can also send a *screenshot* of the payment.`,
    buttons: [{ id: 'utr:skip', title: "I don't have it" }],
  });
}

export async function onPaymentReference(ctx: Ctx, reference: string, isScreenshot = false) {
  const code = ctx.session.data.bookingCode;
  if (!code) return showMyBookings(ctx);
  const ref = reference.replace(/\s+/g, '');
  if (!isScreenshot && ref && !/^[A-Za-z0-9]{6,35}$/.test(ref)) {
    await reply(ctx, {
      kind: 'buttons',
      body: "That doesn't look like a UPI reference. It is usually a 12-digit number like *412345678901*. Please try again or send a screenshot.",
      buttons: [{ id: 'utr:skip', title: "I don't have it" }],
    });
    return;
  }
  const b = await ownBooking(ctx, code);
  if (!b) return;
  try {
    const updated = submitPaymentClaim(b.id, isScreenshot ? `screenshot${reference ? ':' + reference : ''}` : ref, ctx.nowMs);
    ctx.session.state = 'idle';
    await reply(ctx, {
      kind: 'buttons',
      body:
        `🙏 Thanks! We're verifying your payment of *${rupees(amountDue(updated) || updated.amount_required)}* for *${updated.code}*.\n\n` +
        'Your slot stays reserved while we check. You will get a confirmation here shortly.',
      buttons: [{ id: `bk:${updated.code}`, title: '📋 View booking' }, MENU_BUTTON],
    });
    await notifyAdmins(
      `💰 Payment to verify\n${adminBookingLine(updated)}\nAmount: ${rupees(Math.max(0, updated.amount_required - updated.amount_paid))}\n` +
        `Ref: ${isScreenshot ? 'screenshot sent in chat' : ref || '(not provided)'}\nVerify in the dashboard → Payments.`,
    );
  } catch (err) {
    if (!(err instanceof BookingError)) throw err;
    ctx.session.state = 'idle';
    await reply(ctx, { kind: 'buttons', body: `⚠️ ${err.message}`, buttons: [HUMAN_BUTTON, MENU_BUTTON] });
  }
}

/* ----------------------------- Cancellation ----------------------------- */

export async function askCancel(ctx: Ctx, code: string) {
  const b = await ownBooking(ctx, code);
  if (!b) return;
  const q = cancellationQuote(b, 'customer', ctx.nowMs);
  if (!q.allowed) {
    await reply(ctx, { kind: 'buttons', body: `⚠️ ${q.reason}\n\nPlease talk to our team if you need help.`, buttons: [HUMAN_BUTTON, MENU_BUTTON] });
    return;
  }
  const refundLine = b.amount_paid > 0 ? `\n\n↩️ *Refund:* ${rupees(q.refund)} — ${q.note}` : '';
  await reply(ctx, {
    kind: 'buttons',
    body: `❓ Cancel booking *${b.code}*?\n\n${b.turf_name}\n${formatDateLong(b.date)} · ${formatRange(b.start_minute, b.end_minute)}${refundLine}`,
    buttons: [
      { id: `cxlyes:${b.code}`, title: '✅ Yes, cancel it' },
      { id: `bk:${b.code}`, title: '↩️ No, keep it' },
    ],
  });
}

export async function confirmCancel(ctx: Ctx, code: string) {
  const b = await ownBooking(ctx, code);
  if (!b) return;
  try {
    const c = cancelBooking(b.id, { by: 'customer' }, ctx.nowMs);
    ctx.session.state = 'idle';
    await reply(ctx, {
      kind: 'buttons',
      body:
        `✅ Booking *${c.code}* has been cancelled.` +
        (c.refund_amount > 0 ? `\n\n↩️ Your refund of *${rupees(c.refund_amount)}* will be processed within 3–5 working days.` : ''),
      buttons: [BOOK_BUTTON, MENU_BUTTON],
    });
    if (b.status === 'confirmed' || c.refund_amount > 0 || b.payment_status === 'verification_pending') {
      await notifyAdmins(
        `❌ Cancelled by customer\n${adminBookingLine(c)}` +
          (c.refund_amount > 0 ? `\nRefund due: ${rupees(c.refund_amount)}` : '') +
          (b.payment_status === 'verification_pending' ? '\n⚠️ A payment claim was pending verification.' : ''),
      );
    }
  } catch (err) {
    if (!(err instanceof BookingError)) throw err;
    await reply(ctx, { kind: 'buttons', body: `⚠️ ${err.message}`, buttons: [HUMAN_BUTTON, MENU_BUTTON] });
  }
}

/* ----------------------------- Rescheduling ----------------------------- */

export async function startReschedule(ctx: Ctx, code: string, page = 0) {
  const b = await ownBooking(ctx, code);
  if (!b) return;
  const check = rescheduleCheck(b, 'customer', ctx.nowMs);
  if (!check.allowed) {
    await reply(ctx, { kind: 'buttons', body: `⚠️ ${check.reason}`, buttons: [HUMAN_BUTTON, MENU_BUTTON] });
    return;
  }
  const turf = getTurf(b.turf_id)!;
  const { rows } = paged(
    availableDates(turf, ctx.nowMs),
    page,
    (d) => ({ id: `rsd:${b.code}:${d.date}`, title: formatDate(d.date), description: d.free > 0 ? `${d.free} slots open` : 'Fully booked / closed' }),
    (p) => `rsp:${b.code}:${p}`,
  );
  await reply(ctx, {
    kind: 'list',
    body: `🔄 *Reschedule ${b.code}*\nCurrently: ${formatDate(b.date)}, ${formatRange(b.start_minute, b.end_minute)}\n\nPick a new date:`,
    button: 'Choose date',
    sections: [{ title: 'Dates', rows }],
  });
}

export async function rescheduleSlots(ctx: Ctx, code: string, date: string, page = 0) {
  const b = await ownBooking(ctx, code);
  if (!b) return;
  const turf = getTurf(b.turf_id)!;
  if (!isValidDate(date) || !isWithinBookingWindow(date, ctx.nowMs)) return startReschedule(ctx, code);
  const duration = b.end_minute - b.start_minute;
  const starts: number[] = [];
  for (let s = turf.open_minute; s + duration <= turf.close_minute; s += turf.slot_minutes) {
    if (date === b.date && s === b.start_minute) continue;
    if (isRangeBookable(turf, date, s, s + duration, { nowMs: ctx.nowMs, excludeBookingId: b.id }).ok) starts.push(s);
  }
  if (starts.length === 0) {
    await reply(ctx, {
      kind: 'buttons',
      body: `😔 No ${durationLabel(duration)} slots are free on ${formatDate(date)}.`,
      buttons: [{ id: `rs:${b.code}`, title: '📅 Another date' }, { id: `bk:${b.code}`, title: '↩️ Keep current' }],
    });
    return;
  }
  const { rows } = paged(
    starts,
    page,
    (s) => ({ id: `rss:${b.code}:${date}:${s}`, title: formatRange(s, s + duration), description: rupees(quote(turf, date, s, duration / turf.slot_minutes).total) }),
    (p) => `rsq:${b.code}:${date}:${p}`,
  );
  await reply(ctx, {
    kind: 'list',
    body: `⏰ Pick a new time on *${formatDateLong(date)}*:`,
    button: 'Choose time',
    sections: [{ title: 'Available', rows }],
  });
}

export async function confirmRescheduleAsk(ctx: Ctx, code: string, date: string, start: number) {
  const b = await ownBooking(ctx, code);
  if (!b) return;
  const turf = getTurf(b.turf_id)!;
  const duration = b.end_minute - b.start_minute;
  const q = quote(turf, date, start, Math.round(duration / turf.slot_minutes));
  const delta = q.total - b.total_amount;
  const priceNote =
    delta > 0
      ? `\n💰 New price ${rupees(q.total)} (+${rupees(delta)}, payable at the venue).`
      : delta < 0
        ? `\n💰 New price ${rupees(q.total)} (${rupees(-delta)} less — adjusted at the venue).`
        : '';
  await reply(ctx, {
    kind: 'buttons',
    body:
      `🔄 Move *${b.code}*\nfrom ${formatDate(b.date)}, ${formatRange(b.start_minute, b.end_minute)}\nto *${formatDate(date)}, ${formatRange(start, start + duration)}*?${priceNote}`,
    buttons: [
      { id: `rsyes:${b.code}:${date}:${start}`, title: '✅ Yes, move it' },
      { id: `rs:${b.code}`, title: '📅 Pick another' },
      { id: `bk:${b.code}`, title: '↩️ Keep current' },
    ],
  });
}

export async function doReschedule(ctx: Ctx, code: string, date: string, start: number) {
  const b = await ownBooking(ctx, code);
  if (!b) return;
  try {
    const r = rescheduleBooking(b.id, date, start, 'customer', ctx.nowMs);
    ctx.session.state = 'idle';
    let extra = '';
    if (r.booking.status === 'confirmed' && r.priceDelta > 0) extra = `\n\n🧾 Extra ${rupees(r.priceDelta)} is payable at the venue.`;
    await reply(ctx, {
      kind: 'buttons',
      body: bookingDetailsText(r.booking, { title: '✅ *Booking rescheduled!*' }) + extra,
      buttons: [{ id: 'mybk', title: '📋 My bookings' }, MENU_BUTTON],
    });
    await notifyAdmins(
      `🔄 Rescheduled by customer\n${adminBookingLine(r.booking)}\nWas: ${formatDate(r.oldDate)} ${formatMinute(r.oldStart)}\nCustomer: ${displayPhone(ctx.phone)}`,
    );
  } catch (err) {
    if (!(err instanceof BookingError)) throw err;
    await reply(ctx, {
      kind: 'buttons',
      body: `😔 ${err.message}`,
      buttons: [{ id: `rs:${b.code}`, title: '📅 Pick another' }, { id: `bk:${b.code}`, title: '↩️ Keep current' }],
    });
  }
}
