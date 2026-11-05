import { get } from '../db/index.js';
import { availableDates, availableSlots, consecutiveFree, isRangeBookable, isWithinBookingWindow } from '../services/availability.js';
import { BookingError, createBooking, getBooking, type BookingView } from '../services/bookings.js';
import { getTurf, listPriceRules, listTurfs, type TurfWithLocation } from '../services/catalog.js';
import { setCustomerName } from '../services/customers.js';
import { quote } from '../services/pricing.js';
import { getNumber } from '../services/settings.js';
import { displayPhone, normalizePhone, rupees, truncate } from '../utils/misc.js';
import { addDays, durationLabel, formatDate, formatDateLong, formatRange, isValidDate, today } from '../utils/time.js';
import { BOOK_BUTTON, HUMAN_BUTTON, MENU_BUTTON, paged, reply, text, type Ctx } from './context.js';
import { sendBookingConfirmed, sendPaymentInstructions } from './notify.js';

function fromPrice(turf: TurfWithLocation): number {
  const prices = [turf.base_price, ...listPriceRules(turf.id).map((r) => r.price)];
  return Math.min(...prices);
}

function currentTurf(ctx: Ctx): TurfWithLocation | null {
  const id = ctx.session.data.turfId;
  const turf = id ? getTurf(id) : undefined;
  return turf && turf.active && turf.location_active ? turf : null;
}

async function restart(ctx: Ctx, why: string) {
  await reply(ctx, { kind: 'buttons', body: `${why}\n\nLet's start again.`, buttons: [BOOK_BUTTON, MENU_BUTTON] });
  ctx.session.state = 'idle';
}

/* ----------------------------- Turf selection ---------------------------- */

export async function startBooking(ctx: Ctx) {
  ctx.session.data = { options: ctx.session.data.options };
  const turfs = listTurfs({ activeOnly: true });
  if (turfs.length === 0) {
    await reply(ctx, { kind: 'buttons', body: '😔 No turfs are open for online booking right now.', buttons: [HUMAN_BUTTON, MENU_BUTTON] });
    return;
  }
  const locations = [...new Map(turfs.map((t) => [t.location_id, t.location_name])).entries()];
  if (locations.length === 1) return chooseLocation(ctx, locations[0]![0]);

  ctx.session.state = 'choose_location';
  const { rows } = paged(
    locations,
    0,
    ([id, name]) => {
      const n = turfs.filter((t) => t.location_id === id).length;
      return { id: `loc:${id}`, title: name, description: `${n} turf${n > 1 ? 's' : ''}` };
    },
    () => 'book',
  );
  await reply(ctx, {
    kind: 'list',
    body: '📍 Which location would you like to play at?',
    button: 'Choose location',
    sections: [{ title: 'Locations', rows }],
  });
}

export async function chooseLocation(ctx: Ctx, locationId: number) {
  const turfs = listTurfs({ activeOnly: true, locationId });
  if (turfs.length === 0) return restart(ctx, 'That location has no turfs open for booking.');
  ctx.session.data.locationId = locationId;
  if (turfs.length === 1) return chooseTurf(ctx, turfs[0]!.id);

  ctx.session.state = 'choose_turf';
  const { rows } = paged(
    turfs,
    0,
    (t) => ({ id: `turf:${t.id}`, title: t.name, description: `${t.sports} · from ${rupees(fromPrice(t))}/hr` }),
    () => `loc:${locationId}`,
  );
  await reply(ctx, {
    kind: 'list',
    header: turfs[0]!.location_name,
    body: '🏟️ Which turf would you like to book?',
    button: 'Choose turf',
    sections: [{ title: 'Turfs', rows }],
  });
}

export async function chooseTurf(ctx: Ctx, turfId: number) {
  const turf = getTurf(turfId);
  if (!turf || !turf.active || !turf.location_active) return restart(ctx, 'Sorry, that turf is not available for booking.');
  ctx.session.data = { locationId: turf.location_id, turfId: turf.id, options: ctx.session.data.options };
  await showDates(ctx, 0);
}

/* -------------------------------- Dates -------------------------------- */

function dateTitle(date: string, nowMs: number) {
  const t = today(nowMs);
  if (date === t) return `Today, ${formatDate(date).split(', ')[1]}`;
  if (date === addDays(t, 1)) return `Tomorrow, ${formatDate(date).split(', ')[1]}`;
  return formatDate(date);
}

export async function showDates(ctx: Ctx, page: number) {
  const turf = currentTurf(ctx);
  if (!turf) return restart(ctx, 'Your booking session has expired.');
  ctx.session.state = 'choose_date';
  const dates = availableDates(turf, ctx.nowMs);
  const { rows } = paged(
    dates,
    page,
    (d) => ({
      id: `date:${d.date}`,
      title: dateTitle(d.date, ctx.nowMs),
      description: d.free > 0 ? `${d.free} slot${d.free > 1 ? 's' : ''} available` : 'Fully booked / closed',
    }),
    (p) => `dpage:${p}`,
  );
  await reply(ctx, {
    kind: 'list',
    header: truncate(turf.name, 60),
    body: `🏟️ *${turf.name}* · ${turf.sports}\n💰 From ${rupees(fromPrice(turf))}/hr\n\n📅 Which day would you like to play?`,
    button: 'Choose date',
    sections: [{ title: 'Dates', rows }],
  });
}

export async function chooseDate(ctx: Ctx, date: string) {
  const turf = currentTurf(ctx);
  if (!turf) return restart(ctx, 'Your booking session has expired.');
  if (!isValidDate(date) || !isWithinBookingWindow(date, ctx.nowMs)) {
    await text(ctx, `That date isn't open for booking. You can book up to ${getNumber('booking_window_days')} days ahead.`);
    return showDates(ctx, 0);
  }
  ctx.session.data.date = date;
  delete ctx.session.data.start;
  delete ctx.session.data.slots;
  await showSlots(ctx, 0);
}

/* -------------------------------- Slots -------------------------------- */

const PERIODS = [
  { key: 'morning', label: '🌅 Morning', from: 0, to: 720 },
  { key: 'afternoon', label: '☀️ Afternoon', from: 720, to: 1020 },
  { key: 'evening', label: '🌆 Evening', from: 1020, to: 1260 },
  { key: 'night', label: '🌙 Night', from: 1260, to: 3000 },
] as const;

/**
 * Lists free slots. Days with many slots first ask for a part of the day so
 * customers don't have to page through a long list.
 */
export async function showSlots(ctx: Ctx, page: number, period?: string) {
  const turf = currentTurf(ctx);
  const date = ctx.session.data.date;
  if (!turf || !date) return restart(ctx, 'Your booking session has expired.');
  const all = availableSlots(turf, date, ctx.nowMs);
  if (all.length === 0) {
    ctx.session.state = 'choose_date';
    await reply(ctx, {
      kind: 'buttons',
      body: `😔 No slots are available on *${formatDate(date)}* at ${turf.name}.`,
      buttons: [{ id: 'dates', title: '📅 Pick another date' }, MENU_BUTTON],
    });
    return;
  }
  ctx.session.state = 'choose_slot';
  const p = PERIODS.find((x) => x.key === period);

  if (!p && all.length > 9) {
    const rows: { id: string; title: string; description?: string }[] = PERIODS.map((x) => ({ x, slots: all.filter((s) => s.start >= x.from && s.start < x.to) }))
      .filter((g) => g.slots.length > 0)
      .map(({ x, slots }) => {
        const prices = slots.map((s) => s.price);
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        return {
          id: `period:${x.key}`,
          title: x.label,
          description: `${formatRange(slots[0]!.start, slots[slots.length - 1]!.end)} · ${slots.length} free · ${min === max ? rupees(min) : `${rupees(min)}–${rupees(max)}`}${slots.some((s) => s.offer) ? ' · 🔥' : ''}`,
        };
      });
    rows.push({ id: 'dates', title: '📅 Change date', description: 'See other days' });
    await reply(ctx, {
      kind: 'list',
      header: `${formatDate(date)} · ${truncate(turf.name, 40)}`,
      body: `⏰ *${all.length} slots available* on ${formatDateLong(date)}.\n\nWhen would you like to play?`,
      button: 'Choose time of day',
      sections: [{ title: 'Time of day', rows }],
    });
    return;
  }

  const slots = p ? all.filter((s) => s.start >= p.from && s.start < p.to) : all;
  if (slots.length === 0) return showSlots(ctx, 0);
  const { rows } = paged(
    slots,
    page,
    (s) => ({
      id: `slot:${s.start}`,
      title: formatRange(s.start, s.end),
      description: `${rupees(s.price)}${s.offer ? ` · 🔥 ${s.offer.title}` : ''}`,
    }),
    (n) => `spage:${p?.key ?? 'all'}:${n}`,
    1,
  );
  rows.push(p ? { id: 'slots', title: '↩️ Other times', description: 'Pick another part of the day' } : { id: 'dates', title: '📅 Change date', description: 'See other days' });
  const hasOffer = slots.some((s) => s.offer);
  await reply(ctx, {
    kind: 'list',
    header: `${formatDate(date)} · ${truncate(turf.name, 40)}`,
    body:
      `⏰ *${slots.length} slot${slots.length > 1 ? 's' : ''} available*${p ? ` in the ${p.key}` : ''} on ${formatDateLong(date)}.\n` +
      `Each slot is ${durationLabel(turf.slot_minutes)}.` +
      (hasOffer ? '\n🔥 Slots marked with an offer get a discount!' : '') +
      '\n\nPick a start time:',
    button: 'Choose time',
    sections: [{ title: p ? p.label.replace(/^\S+\s/, '') : 'Available slots', rows }],
  });
}

export async function chooseSlot(ctx: Ctx, start: number) {
  const turf = currentTurf(ctx);
  const date = ctx.session.data.date;
  if (!turf || !date || !Number.isInteger(start)) return restart(ctx, 'Your booking session has expired.');
  const check = isRangeBookable(turf, date, start, start + turf.slot_minutes, { nowMs: ctx.nowMs });
  if (!check.ok) {
    await text(ctx, `😔 ${check.reason}`);
    return showSlots(ctx, 0);
  }
  ctx.session.data.start = start;
  const n = consecutiveFree(turf, date, start, turf.max_slots_per_booking, ctx.nowMs);
  if (n <= 1) return chooseDuration(ctx, 1);

  ctx.session.state = 'choose_duration';
  const buttons = Array.from({ length: Math.min(n, 3) }, (_, i) => {
    const k = i + 1;
    const q = quote(turf, date, start, k);
    return { id: `dur:${k}`, title: `${durationLabel(k * turf.slot_minutes)} · ${rupees(q.total)}` };
  });
  await reply(ctx, {
    kind: 'buttons',
    body: `⏱️ How long would you like to play from *${formatRange(start, start + turf.slot_minutes).split(' – ')[0]}*?`,
    buttons,
  });
}

export async function chooseDuration(ctx: Ctx, slots: number) {
  const turf = currentTurf(ctx);
  const { date, start } = ctx.session.data;
  if (!turf || !date || start === undefined) return restart(ctx, 'Your booking session has expired.');
  const max = consecutiveFree(turf, date, start, turf.max_slots_per_booking, ctx.nowMs);
  if (!Number.isInteger(slots) || slots < 1 || slots > max) {
    await text(ctx, '😔 That duration is no longer available.');
    return showSlots(ctx, 0);
  }
  ctx.session.data.slots = slots;
  await askName(ctx);
}

/* ---------------------------- Customer details --------------------------- */

export async function askName(ctx: Ctx) {
  const saved = ctx.customer.name;
  if (saved) {
    ctx.session.state = 'ask_name';
    await reply(ctx, {
      kind: 'buttons',
      body: `👤 Should we put this booking under the name *${saved}*?`,
      buttons: [
        { id: 'name:keep', title: truncate(`✅ Yes, ${saved}`, 20) },
        { id: 'name:new', title: '✏️ Different name' },
      ],
    });
    return;
  }
  ctx.session.state = 'enter_name';
  const profile = ctx.customer.whatsapp_name.trim();
  if (profile && isPlausibleName(profile)) {
    await reply(ctx, {
      kind: 'buttons',
      body: `👤 What name should we put the booking under?\n\nType your name, or tap below to use *${profile}*.`,
      buttons: [{ id: 'name:profile', title: truncate(`Use ${profile}`, 20) }],
    });
  } else {
    await text(ctx, '👤 What name should we put the booking under? Please type your name.');
  }
}

export function isPlausibleName(s: string) {
  const t = s.trim();
  return t.length >= 2 && t.length <= 60 && /\p{L}/u.test(t) && !/https?:|www\./i.test(t) && !/\d{4,}/.test(t);
}

export async function onName(ctx: Ctx, raw: string) {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!isPlausibleName(name)) {
    ctx.session.state = 'enter_name';
    await text(ctx, 'Please type a valid name (2–60 letters).');
    return;
  }
  ctx.session.data.name = name;
  if (ctx.customer.name !== name) {
    setCustomerName(ctx.customer.id, name);
    ctx.customer.name = name;
  }
  await askPhone(ctx);
}

export async function onNameAction(ctx: Ctx, which: string) {
  if (which === 'keep' && ctx.customer.name) return onName(ctx, ctx.customer.name);
  if (which === 'profile' && ctx.customer.whatsapp_name) return onName(ctx, ctx.customer.whatsapp_name);
  ctx.session.state = 'enter_name';
  await text(ctx, '✏️ Please type the name for this booking.');
}

export async function askPhone(ctx: Ctx) {
  ctx.session.state = 'ask_phone';
  await reply(ctx, {
    kind: 'buttons',
    body: '📱 Which mobile number should we use for this booking?',
    buttons: [
      { id: 'phone:wa', title: truncate(`📱 ${displayPhone(ctx.phone)}`, 20) },
      { id: 'phone:new', title: '✏️ Other number' },
    ],
  });
}

export async function onPhoneAction(ctx: Ctx, which: string) {
  if (which === 'wa') return onPhone(ctx, ctx.phone);
  ctx.session.state = 'enter_phone';
  await text(ctx, '✏️ Please type the 10-digit mobile number.');
}

export async function onPhone(ctx: Ctx, raw: string) {
  const phone = normalizePhone(raw);
  if (!phone) {
    ctx.session.state = 'enter_phone';
    await text(ctx, "That doesn't look like a valid mobile number. Please type a 10-digit number, e.g. 9876543210.");
    return;
  }
  ctx.session.data.phone = phone;
  await showSummary(ctx);
}

/* -------------------------- Summary & confirmation ------------------------ */

function policyLine(): string {
  const free = getNumber('free_cancel_hours');
  return `ℹ️ Free cancellation up to ${free} hours before your slot.`;
}

export async function showSummary(ctx: Ctx) {
  const turf = currentTurf(ctx);
  const { date, start, slots, name, phone } = ctx.session.data;
  if (!turf || !date || start === undefined || !slots || !name || !phone) return restart(ctx, 'Your booking session has expired.');
  const end = start + slots * turf.slot_minutes;
  const q = quote(turf, date, start, slots);
  const lines = [
    '📝 *Booking summary*',
    '',
    `🏟️ *Turf:* ${turf.name} (${turf.location_name})`,
    `📅 *Date:* ${formatDateLong(date)}`,
    `⏰ *Time:* ${formatRange(start, end)} (${durationLabel(end - start)})`,
    `👤 *Name:* ${name}`,
    `📱 *Mobile:* ${displayPhone(phone)}`,
    q.discount > 0
      ? `💰 *Price:* ~${rupees(q.gross)}~ *${rupees(q.total)}*\n🔥 *Offer:* ${q.offer!.title} (−${rupees(q.discount)})`
      : `💰 *Price:* *${rupees(q.total)}*`,
  ];
  if (q.advanceAllowed) lines.push(`💳 Pay *${rupees(q.advance)}* advance (${turf.advance_percent}%) or the full amount to confirm.`);
  lines.push('', policyLine(), '', 'Shall I go ahead?');
  ctx.session.state = 'confirm_summary';
  await reply(ctx, {
    kind: 'buttons',
    body: lines.join('\n'),
    buttons: [
      { id: 'sum:confirm', title: '✅ Confirm' },
      { id: 'sum:change', title: '🔄 Change slot' },
      { id: 'sum:cancel', title: '❌ Cancel' },
    ],
  });
}

export async function onSummaryAction(ctx: Ctx, which: string) {
  if (which === 'change') return showSlots(ctx, 0);
  if (which === 'cancel') {
    ctx.session.state = 'idle';
    ctx.session.data = {};
    await reply(ctx, { kind: 'buttons', body: 'No problem — nothing was booked. 👍', buttons: [BOOK_BUTTON, MENU_BUTTON] });
    return;
  }
  const turf = currentTurf(ctx);
  const { date, start, slots } = ctx.session.data;
  if (!turf || !date || start === undefined || !slots) return restart(ctx, 'Your booking session has expired.');
  const q = quote(turf, date, start, slots);
  if (q.advanceAllowed) {
    ctx.session.state = 'choose_payment';
    await reply(ctx, {
      kind: 'buttons',
      body: `💳 How would you like to pay?\n\n• *Advance:* ${rupees(q.advance)} now, ${rupees(q.total - q.advance)} at the venue\n• *Full:* ${rupees(q.total)} now`,
      buttons: [
        { id: 'payopt:advance', title: truncate(`Advance ${rupees(q.advance)}`, 20) },
        { id: 'payopt:full', title: truncate(`Full ${rupees(q.total)}`, 20) },
      ],
    });
    return;
  }
  await createAndPay(ctx, 'full');
}

/** Finds an existing unpaid hold for the exact same slot (e.g. user tapped Confirm twice). */
function existingHold(ctx: Ctx, turfId: number, date: string, start: number): BookingView | undefined {
  const row = get<{ id: number }>(
    `SELECT id FROM bookings WHERE customer_id = ? AND turf_id = ? AND date = ? AND start_minute = ? AND status = 'pending_payment'`,
    ctx.customer.id,
    turfId,
    date,
    start,
  );
  return row ? getBooking(row.id) : undefined;
}

export async function createAndPay(ctx: Ctx, option: 'advance' | 'full') {
  const turf = currentTurf(ctx);
  const { date, start, slots, name, phone } = ctx.session.data;
  if (!turf || !date || start === undefined || !slots || !name || !phone) return restart(ctx, 'Your booking session has expired.');

  const dup = existingHold(ctx, turf.id, date, start);
  if (dup) {
    ctx.session.state = 'awaiting_payment';
    ctx.session.data.bookingCode = dup.code;
    await sendPaymentInstructions(ctx.phone, dup);
    return;
  }

  let booking: BookingView;
  try {
    booking = createBooking({
      turfId: turf.id,
      customerId: ctx.customer.id,
      date,
      startMinute: start,
      slots,
      contactName: name,
      contactPhone: phone,
      paymentOption: option,
      nowMs: ctx.nowMs,
    });
  } catch (err) {
    if (err instanceof BookingError) {
      if (err.code === 'unavailable') {
        await text(ctx, `😔 Sorry! ${err.message} Here are the slots still open:`);
        return showSlots(ctx, 0);
      }
      ctx.session.state = 'idle';
      await reply(ctx, { kind: 'buttons', body: `⚠️ ${err.message}`, buttons: [{ id: 'mybk', title: '📋 My bookings' }, MENU_BUTTON] });
      return;
    }
    throw err;
  }

  ctx.session.data = { bookingCode: booking.code };
  if (booking.status === 'confirmed') {
    ctx.session.state = 'idle';
    await sendBookingConfirmed(booking);
    return;
  }
  ctx.session.state = 'awaiting_payment';
  await text(
    ctx,
    `📌 *Slot reserved!* Your booking ID is *${booking.code}*.\n\n${booking.turf_name} · ${formatDate(booking.date)} · ${formatRange(booking.start_minute, booking.end_minute)}`,
  );
  await sendPaymentInstructions(ctx.phone, booking);
}
