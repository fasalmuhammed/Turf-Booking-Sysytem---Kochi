import { run } from '../db/index.js';
import { upcomingForCustomer } from '../services/bookings.js';
import { upsertCustomer } from '../services/customers.js';
import { getSetting } from '../services/settings.js';
import { getTransport } from '../whatsapp/client.js';
import type { InboundMessage } from '../whatsapp/types.js';
import {
  askName,
  askPhone,
  chooseDate,
  chooseDuration,
  chooseLocation,
  chooseSlot,
  chooseTurf,
  createAndPay,
  isPlausibleName,
  onName,
  onNameAction,
  onPhone,
  onPhoneAction,
  onSummaryAction,
  showDates,
  showSlots,
  showSummary,
  startBooking,
} from './booking-flow.js';
import { BOOK_BUTTON, HUMAN_BUTTON, MENU_BUTTON, norm, reply, text, type Ctx } from './context.js';
import {
  askCancel,
  confirmCancel,
  confirmRescheduleAsk,
  doReschedule,
  onPaymentReference,
  rescheduleSlots,
  resendPayment,
  showBooking,
  showMyBookings,
  startPaymentClaim,
  startReschedule,
} from './manage-flow.js';
import { loadSession, saveSession } from './session.js';
import {
  handoff,
  HUMAN_MODE_TIMEOUT_MS,
  searchFaq,
  showFaq,
  showFaqMenu,
  showLocationInfo,
  showPolicies,
  showPricing,
} from './support-flow.js';

const SESSION_TTL_MS = 30 * 60_000;
const FLOW_STATES = new Set([
  'choose_location',
  'choose_turf',
  'choose_date',
  'choose_slot',
  'choose_duration',
  'ask_name',
  'enter_name',
  'ask_phone',
  'enter_phone',
  'confirm_summary',
  'choose_payment',
]);

/* --------------------------- Inbound pipeline --------------------------- */

const queues = new Map<string, Promise<void>>();

/** Logs the message (deduplicating webhook retries) and processes messages from one number in order. */
export async function handleInbound(msg: InboundMessage): Promise<void> {
  try {
    run(
      `INSERT INTO messages (phone, direction, wa_message_id, type, body, created_at) VALUES (?, 'in', ?, ?, ?, ?)`,
      msg.from,
      msg.id,
      msg.kind === 'reply' ? 'reply' : msg.rawType,
      msg.kind === 'other' ? `[${msg.rawType}]${msg.mediaId ? ` media:${msg.mediaId}` : ''}${msg.text ? ' ' + msg.text : ''}` : msg.text,
      Date.now(),
    );
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) return; // duplicate delivery
    throw err;
  }
  getTransport().markRead?.(msg.id).catch(() => undefined);

  const prev = queues.get(msg.from) ?? Promise.resolve();
  const next = prev.then(() => processMessage(msg)).catch((err) => console.error('[bot] error', err));
  queues.set(msg.from, next);
  await next;
  if (queues.get(msg.from) === next) queues.delete(msg.from);
}

async function processMessage(msg: InboundMessage) {
  const nowMs = Date.now();
  const customer = upsertCustomer(msg.from, msg.profileName);
  const session = loadSession(msg.from);
  const isFirstContact = session.updated_at === 0;
  session.last_inbound_at = nowMs;
  const ctx: Ctx = { phone: msg.from, msg, customer, session, nowMs };

  try {
    if (session.mode === 'human') {
      const t = norm(msg.text);
      const expired = session.human_requested_at !== null && nowMs - session.human_requested_at > HUMAN_MODE_TIMEOUT_MS;
      if (['menu', 'bot', 'main menu', 'restart', 'start'].includes(t) || msg.replyId === 'menu' || expired) {
        session.mode = 'bot';
        session.human_requested_at = null;
        if (!expired) {
          await showMainMenu(ctx, false);
          return;
        }
      } else {
        return; // a team member is handling this chat from the dashboard
      }
    }

    if (FLOW_STATES.has(session.state) && nowMs - session.updated_at > SESSION_TTL_MS && msg.kind !== 'reply') {
      session.state = 'idle';
      session.data = {};
    }
    await route(ctx, isFirstContact);
  } catch (err) {
    console.error('[bot] failed to handle message', err);
    session.state = 'idle';
    await reply(ctx, {
      kind: 'buttons',
      body: '😕 Sorry, something went wrong on our side. Please try again.',
      buttons: [MENU_BUTTON, HUMAN_BUTTON],
    });
  } finally {
    saveSession(session);
  }
}

/* -------------------------------- Routing ------------------------------- */

const GREETING = /^(hi+|hello+|hey+|hai|helo|hola|namaste|namaskar|vanakkam|good (morning|afternoon|evening)|start|menu|main menu|home|restart|0)\b/;
const AFFIRM = /^(yes|y|yeah|yep|ok|okay|sure|confirm|haan|ha|done)$/;

function matchOption(ctx: Ctx, raw: string): string | null {
  const opts = ctx.session.data.options ?? [];
  if (opts.length === 0) return null;
  const t = raw.trim();
  if (/^\d{1,2}$/.test(t)) {
    const i = Number(t) - 1;
    return opts[i]?.id ?? null;
  }
  const n = norm(t);
  if (!n) return null;
  const exact = opts.find((o) => norm(o.title) === n);
  if (exact) return exact.id;
  if (AFFIRM.test(n) && opts.length <= 3 && ['confirm_summary', 'choose_payment'].includes(ctx.session.state)) return opts[0]!.id;
  return null;
}

async function route(ctx: Ctx, isFirstContact: boolean) {
  const { msg, session } = ctx;
  const raw = msg.text.trim();
  const lower = norm(raw);

  // 1. Taps on buttons/list rows (or typed option numbers/titles)
  let action = msg.kind === 'reply' ? msg.replyId : '';
  const typingState = ['enter_name', 'enter_phone', 'enter_utr'].includes(session.state);
  if (!action && raw && !typingState) action = matchOption(ctx, raw) ?? '';
  if (action) return handleAction(ctx, action);

  // 2. Media (payment screenshots) and unsupported types
  if (msg.kind === 'other') {
    if (session.state === 'enter_utr' && msg.mediaId) return onPaymentReference(ctx, msg.mediaId, true);
    if (msg.mediaId && upcomingForCustomer(ctx.customer.id, ctx.nowMs).some((b) => b.status === 'pending_payment')) {
      const pending = upcomingForCustomer(ctx.customer.id, ctx.nowMs).filter((b) => b.status === 'pending_payment');
      if (pending.length === 1) {
        session.data.bookingCode = pending[0]!.code;
        return onPaymentReference(ctx, msg.mediaId, true);
      }
    }
    await reply(ctx, {
      kind: 'buttons',
      body: "📎 Thanks! I can only understand text messages and button taps. Here's what I can help with:",
      buttons: [BOOK_BUTTON, { id: 'mybk', title: '📋 My bookings' }, HUMAN_BUTTON],
    });
    return;
  }

  // 3. Global commands that work from any state
  if (isFirstContact && !/\bbook/.test(lower)) return showMainMenu(ctx, true);
  if (/^(cancel|stop|exit|quit|back)$/.test(lower) && FLOW_STATES.has(session.state)) {
    session.state = 'idle';
    session.data = {};
    await reply(ctx, { kind: 'buttons', body: 'Okay, I stopped that booking. Nothing was reserved. 👍', buttons: [BOOK_BUTTON, MENU_BUTTON] });
    return;
  }
  if (GREETING.test(lower) && !/\bbook/.test(lower)) return showMainMenu(ctx, true);

  // 4. Free text the current step is waiting for
  switch (session.state) {
    case 'enter_name':
      return onName(ctx, raw);
    case 'enter_phone':
      return onPhone(ctx, raw);
    case 'enter_utr':
      return onPaymentReference(ctx, raw);
    case 'ask_name':
      if (isPlausibleName(raw) && raw.split(' ').length <= 4 && !keywordIntent(lower)) return onName(ctx, raw);
      break;
    case 'ask_phone':
      if (/^[+\d\s-]{10,16}$/.test(raw)) return onPhone(ctx, raw);
      break;
  }

  // 5. Keywords / intents
  const code = /\bTB[0-9A-Z]{6}\b/i.exec(raw);
  if (code) return showBooking(ctx, code[0].toUpperCase());
  switch (keywordIntent(lower)) {
    case 'mybookings':
      return showMyBookings(ctx);
    case 'book':
      return startBooking(ctx);
    case 'human':
      return handoff(ctx);
    case 'price':
      return showPricing(ctx);
    case 'location':
      return showLocationInfo(ctx);
    case 'policy':
      return showPolicies(ctx);
    case 'cancel':
      await text(ctx, 'To cancel or reschedule, pick the booking below 👇');
      return showMyBookings(ctx);
    case 'faq':
      return showFaqMenu(ctx);
    case 'thanks':
      await reply(ctx, { kind: 'buttons', body: "You're welcome! 😊 Anything else?", buttons: [BOOK_BUTTON, { id: 'mybk', title: '📋 My bookings' }, MENU_BUTTON] });
      return;
  }

  // A bare UPI reference with exactly one unpaid booking → treat it as a payment claim
  if (/^\d{12}$/.test(raw.replace(/\s/g, ''))) {
    const pending = upcomingForCustomer(ctx.customer.id, ctx.nowMs).filter((b) => b.status === 'pending_payment');
    if (pending.length === 1) {
      session.data.bookingCode = pending[0]!.code;
      return onPaymentReference(ctx, raw);
    }
  }

  const faq = searchFaq(raw);
  if (faq) return showFaq(ctx, faq.id);

  // 6. Graceful fallback, re-prompting the current step where possible
  if (FLOW_STATES.has(session.state)) {
    await text(ctx, "🤔 Sorry, I didn't get that. Please tap one of the options below (or type *cancel* to stop).");
    return repromptState(ctx);
  }
  await reply(ctx, {
    kind: 'buttons',
    body: "🤔 Sorry, I didn't quite get that. I can help you book a turf, manage your bookings, or connect you with our team.",
    buttons: [BOOK_BUTTON, { id: 'faq', title: '❓ Help & FAQs' }, HUMAN_BUTTON],
  });
}

function keywordIntent(lower: string): string | null {
  if (/\b(my bookings?|my booking|booking status|check (my )?booking|view booking|my slots?)\b/.test(lower)) return 'mybookings';
  if (/\b(cancel|reschedule|change (my )?(booking|slot|time|date))\b/.test(lower)) return 'cancel';
  if (/\b(book|booking|reserve|slot|slots|available|availability|play|game|match)\b/.test(lower)) return 'book';
  if (/\b(agent|human|person|someone|executive|staff|manager|owner|call me|talk|speak|support|customer care|contact)\b/.test(lower)) return 'human';
  if (/\b(price|prices|pricing|rate|rates|cost|charge|charges|fee|fees|tariff|offer|offers|discount|deal|coupon)\b/.test(lower)) return 'price';
  if (/\b(where|location|address|direction|directions|map|reach|timing|timings|open|close|hours)\b/.test(lower)) return 'location';
  if (/\b(rule|rules|policy|policies|refund|refunds|shoes|studs)\b/.test(lower)) return 'policy';
  if (/\b(help|faq|faqs|info|question|questions)\b/.test(lower)) return 'faq';
  if (/^(thanks?|thank you|thx|ty|ok|okay|cool|great|nice|super|done)( you| so much)?$/.test(lower)) return 'thanks';
  return null;
}

async function repromptState(ctx: Ctx) {
  switch (ctx.session.state) {
    case 'choose_location':
    case 'choose_turf':
      return startBooking(ctx);
    case 'choose_date':
      return showDates(ctx, 0);
    case 'choose_slot':
    case 'choose_duration':
      return showSlots(ctx, 0);
    case 'ask_name':
    case 'enter_name':
      return askName(ctx);
    case 'ask_phone':
    case 'enter_phone':
      return askPhone(ctx);
    case 'confirm_summary':
      return showSummary(ctx);
    case 'choose_payment':
      return onSummaryAction(ctx, 'confirm');
    default:
      return showMainMenu(ctx, false);
  }
}

/* -------------------------------- Actions ------------------------------- */

async function handleAction(ctx: Ctx, action: string) {
  const [act, ...rest] = action.split(':');
  const arg = rest[0] ?? '';
  switch (act) {
    case 'menu':
      return showMainMenu(ctx, false);
    case 'book':
      return startBooking(ctx);
    case 'loc':
      return chooseLocation(ctx, Number(arg));
    case 'turf':
      return chooseTurf(ctx, Number(arg));
    case 'dates':
      return showDates(ctx, 0);
    case 'dpage':
      return showDates(ctx, Number(arg));
    case 'date':
      return chooseDate(ctx, arg);
    case 'slots':
      return showSlots(ctx, 0);
    case 'period':
      return showSlots(ctx, 0, arg);
    case 'spage':
      return showSlots(ctx, Number(rest[1] ?? 0), arg === 'all' ? undefined : arg);
    case 'slot':
      return chooseSlot(ctx, Number(arg));
    case 'dur':
      return chooseDuration(ctx, Number(arg));
    case 'name':
      return onNameAction(ctx, arg);
    case 'phone':
      return onPhoneAction(ctx, arg);
    case 'sum':
      return onSummaryAction(ctx, arg);
    case 'payopt':
      return createAndPay(ctx, arg === 'advance' ? 'advance' : 'full');
    case 'mybk':
      return showMyBookings(ctx);
    case 'bk':
      return showBooking(ctx, arg);
    case 'pay':
      return resendPayment(ctx, arg);
    case 'paid':
      return startPaymentClaim(ctx, arg);
    case 'utr':
      return onPaymentReference(ctx, '');
    case 'cxl':
      return askCancel(ctx, arg);
    case 'cxlyes':
      return confirmCancel(ctx, arg);
    case 'rs':
      return startReschedule(ctx, arg);
    case 'rsp':
      return startReschedule(ctx, arg, Number(rest[1]));
    case 'rsd':
      return rescheduleSlots(ctx, arg, rest[1] ?? '');
    case 'rsq':
      return rescheduleSlots(ctx, arg, rest[1] ?? '', Number(rest[2]));
    case 'rss':
      return confirmRescheduleAsk(ctx, arg, rest[1] ?? '', Number(rest[2]));
    case 'rsyes':
      return doReschedule(ctx, arg, rest[1] ?? '', Number(rest[2]));
    case 'faq':
      return arg ? showFaq(ctx, Number(arg)) : showFaqMenu(ctx);
    case 'faqp':
      return showFaqMenu(ctx, Number(arg));
    case 'info':
      if (arg === 'loc') return showLocationInfo(ctx);
      if (arg === 'price') return showPricing(ctx);
      return showPolicies(ctx);
    case 'human':
      return handoff(ctx);
    default:
      return showMainMenu(ctx, false);
  }
}

/* ------------------------------- Main menu ------------------------------ */

export async function showMainMenu(ctx: Ctx, greet: boolean) {
  ctx.session.state = 'idle';
  ctx.session.data = {};
  const name = (ctx.customer.name || ctx.customer.whatsapp_name).split(' ')[0];
  const upcoming = upcomingForCustomer(ctx.customer.id, ctx.nowMs);
  const unpaid = upcoming.filter((b) => b.status === 'pending_payment');
  let body = greet
    ? `👋 Hi${name ? ` ${name}` : ''}! Welcome to *${getSetting('business_name')}*.\n\n${getSetting('welcome_message')}`
    : 'What would you like to do?';
  if (upcoming.length) {
    body += `\n\n📋 You have ${upcoming.length} upcoming booking${upcoming.length > 1 ? 's' : ''}` + (unpaid.length ? ` (${unpaid.length} awaiting payment).` : '.');
  }
  body += "\n\n_Type *agent* anytime to chat with our team._";
  await reply(ctx, {
    kind: 'buttons',
    body,
    buttons: [BOOK_BUTTON, { id: 'mybk', title: '📋 My bookings' }, { id: 'faq', title: '❓ Help & FAQs' }],
  });
}
