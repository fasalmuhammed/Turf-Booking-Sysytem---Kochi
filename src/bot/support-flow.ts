import { config } from '../config.js';
import { getFaq, listFaqs, listLocations, listOffers, listPriceRules, listTurfs } from '../services/catalog.js';
import { getNumber, getSetting } from '../services/settings.js';
import type { Faq } from '../types.js';
import { displayPhone, parseIntList, rupees, truncate } from '../utils/misc.js';
import { dayName, formatMinute, formatRange } from '../utils/time.js';
import { BOOK_BUTTON, HUMAN_BUTTON, MENU_BUTTON, norm, paged, reply, type Ctx } from './context.js';
import { notifyAdmins } from './notify.js';

const FAQ_BUTTON = { id: 'faq', title: '❓ More help' };

export async function showFaqMenu(ctx: Ctx, page = 0) {
  ctx.session.state = 'faq';
  const faqs = listFaqs(true);
  const quick = [
    { id: 'info:loc', title: '📍 Location & timings', description: 'Address, map and opening hours' },
    { id: 'info:price', title: '💰 Prices & offers', description: 'Hourly rates and current deals' },
    { id: 'info:policy', title: '📜 Rules & policies', description: 'Turf rules, cancellation, refunds' },
  ];
  const human = { id: 'human', title: '🙋 Talk to our team', description: 'Chat with a person' };
  if (page === 0 && faqs.length <= 6) {
    await reply(ctx, {
      kind: 'list',
      body: '❓ How can I help? Pick a topic below, or just type your question.',
      button: 'Help topics',
      sections: [
        { title: 'Quick info', rows: quick },
        { title: 'FAQs', rows: [...faqs.map(faqRow), human] },
      ],
    });
    return;
  }
  const { rows } = paged(faqs, page, faqRow, (p) => `faqp:${p}`, 1);
  rows.push(human);
  await reply(ctx, {
    kind: 'list',
    body: '❓ Frequently asked questions — pick one, or type your question.',
    button: 'Questions',
    sections: [{ title: 'FAQs', rows }],
  });
  if (page === 0) {
    await reply(ctx, { kind: 'list', body: 'Or see quick info:', button: 'Quick info', sections: [{ title: 'Quick info', rows: quick }] });
  }
}

const faqRow = (f: Faq) => ({ id: `faq:${f.id}`, title: truncate(f.question, 24), description: truncate(f.question.length > 24 ? f.question : f.answer, 72) });

export async function showFaq(ctx: Ctx, id: number) {
  const f = getFaq(id);
  if (!f || !f.active) return showFaqMenu(ctx);
  await reply(ctx, { kind: 'buttons', body: `*${f.question}*\n\n${f.answer}`, buttons: [FAQ_BUTTON, BOOK_BUTTON, HUMAN_BUTTON] });
}

export function closedDaysText(closed: string) {
  const days = parseIntList(closed);
  return days.length ? ` (closed ${days.map((d) => dayName(d, true)).join(', ')})` : '';
}

export async function showLocationInfo(ctx: Ctx) {
  const parts: string[] = [];
  for (const loc of listLocations(true)) {
    const lines = [`📍 *${loc.name}*`];
    if (loc.address) lines.push(loc.address);
    if (loc.maps_url) lines.push(`🗺️ ${loc.maps_url}`);
    if (loc.contact_phone) lines.push(`📞 ${loc.contact_phone}`);
    for (const t of listTurfs({ activeOnly: true, locationId: loc.id })) {
      lines.push(`🏟️ ${t.name} — ${formatRange(t.open_minute, t.close_minute)}${closedDaysText(t.closed_days)}`);
    }
    parts.push(lines.join('\n'));
  }
  await reply(ctx, {
    kind: 'buttons',
    body: parts.join('\n\n') || 'Location details will be shared by our team.',
    buttons: [BOOK_BUTTON, FAQ_BUTTON, MENU_BUTTON],
  });
}

function daysLabel(days: string) {
  const d = parseIntList(days).sort();
  if (d.length === 0) return 'Every day';
  if (d.join() === '0,6') return 'Weekends';
  if (d.join() === '1,2,3,4,5') return 'Weekdays';
  return d.map((x) => dayName(x)).join(', ');
}

export function pricingText(): string {
  const parts: string[] = ['💰 *Prices*'];
  for (const t of listTurfs({ activeOnly: true })) {
    const lines = [`\n🏟️ *${t.name}* (${t.location_name}) — ${t.sports}`, `• Standard: ${rupees(t.base_price)}/hr`];
    for (const r of listPriceRules(t.id)) {
      lines.push(`• ${r.label || daysLabel(r.days)} (${daysLabel(r.days)}, ${formatMinute(r.start_minute)}–${formatMinute(r.end_minute)}): ${rupees(r.price)}/hr`);
    }
    if (t.advance_percent > 0 && t.advance_percent < 100) lines.push(`• Book with ${t.advance_percent}% advance, rest at the venue`);
    parts.push(lines.join('\n'));
  }
  const offers = listOffers({ activeOnly: true });
  if (offers.length) {
    parts.push('\n🔥 *Current offers*');
    for (const o of offers) {
      const off = o.discount_type === 'percent' ? `${o.discount_value}% off` : `${rupees(o.discount_value)} off`;
      const where = o.turf_name ? ` on ${o.turf_name}` : '';
      const when =
        o.start_minute !== null && o.end_minute !== null ? `, ${formatMinute(o.start_minute)}–${formatMinute(o.end_minute)}` : '';
      parts.push(`• *${o.title}* — ${off}${where} (${daysLabel(o.days)}${when})${o.description ? `\n  ${o.description}` : ''}`);
    }
  }
  return parts.join('\n');
}

export async function showPricing(ctx: Ctx) {
  await reply(ctx, { kind: 'buttons', body: pricingText(), buttons: [BOOK_BUTTON, FAQ_BUTTON, MENU_BUTTON] });
}

export function policyText(): string {
  const free = getNumber('free_cancel_hours');
  const late = getNumber('late_cancel_refund_percent');
  const cutoff = getNumber('cancel_cutoff_hours');
  const rs = getNumber('reschedule_cutoff_hours');
  const maxRs = getNumber('max_reschedules');
  const hold = getNumber('hold_minutes');
  const rules = getSetting('turf_rules');
  return [
    rules ? `📜 *Turf rules*\n${rules}` : '',
    '❌ *Cancellation*',
    `• Cancel ${free}+ hours before: full refund`,
    `• Cancel later: ${late}% refund`,
    `• No cancellations within ${cutoff} hour${cutoff === 1 ? '' : 's'} of the slot`,
    '',
    '🔄 *Rescheduling*',
    maxRs > 0 ? `• Up to ${maxRs} time${maxRs > 1 ? 's' : ''}, at least ${rs} hours before the slot` : '• Not available online',
    '',
    '💳 *Payment*',
    `• Unpaid slots are held for ${hold} minutes`,
    '• Refunds are processed within 3–5 working days',
  ]
    .filter((l, i) => !(i === 0 && !l))
    .join('\n');
}

export async function showPolicies(ctx: Ctx) {
  await reply(ctx, { kind: 'buttons', body: policyText(), buttons: [BOOK_BUTTON, FAQ_BUTTON, MENU_BUTTON] });
}

/* ------------------------------ FAQ search ------------------------------ */

const STOP = new Set(
  'the a an is are am do does did can could i you we to of for on in at and or with my me your our it this that what how when where which who there be have has any about please pls'.split(' '),
);
const tokens = (s: string) => norm(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w));

/** Best FAQ for free text by keyword overlap, or null if nothing is a convincing match. */
export function searchFaq(input: string): Faq | null {
  const q = new Set(tokens(input));
  if (q.size === 0) return null;
  let best: Faq | null = null;
  let bestScore = 0;
  for (const f of listFaqs(true)) {
    const ft = new Set([...tokens(f.question), ...tokens(f.answer).slice(0, 12)]);
    let hits = 0;
    for (const w of q) if ([...ft].some((x) => x === w || (w.length > 4 && (x.startsWith(w) || w.startsWith(x))))) hits++;
    const score = hits / Math.max(2, q.size);
    if (hits > 0 && score > bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

/* ---------------------------- Human hand-off ---------------------------- */

export async function handoff(ctx: Ctx) {
  ctx.session.mode = 'human';
  ctx.session.human_requested_at = ctx.nowMs;
  ctx.session.state = 'idle';
  const support = getSetting('support_phone');
  await reply(ctx, {
    kind: 'text',
    text: `🙋 ${getSetting('handoff_message')}${support ? `\n\nPrefer to call? 📞 ${support}` : ''}`,
  });
  const who = ctx.customer.name || ctx.customer.whatsapp_name || 'A customer';
  await notifyAdmins(`🙋 ${who} (${displayPhone(ctx.phone)}) wants to talk to the team.\nReply from the dashboard → Inbox.`);
}

export const HUMAN_MODE_TIMEOUT_MS = 12 * 3_600_000;

export const isAdminNumber = (phone: string) => config.adminNumbers.includes(phone);
