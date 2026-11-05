import type { Customer } from '../types.js';
import { sendMessage } from '../whatsapp/client.js';
import type { InboundMessage, OutboundMessage } from '../whatsapp/types.js';
import type { Session } from './session.js';

export interface Ctx {
  phone: string;
  msg: InboundMessage;
  customer: Customer;
  session: Session;
  nowMs: number;
}

/** Sends a reply and remembers its options so typed numbers / titles map back to them. */
export async function reply(ctx: Ctx, m: OutboundMessage) {
  if (m.kind === 'buttons') ctx.session.data.options = m.buttons.map((b) => ({ id: b.id, title: b.title }));
  else if (m.kind === 'list') ctx.session.data.options = m.sections.flatMap((s) => s.rows.map((r) => ({ id: r.id, title: r.title })));
  await sendMessage(ctx.phone, m);
}

export const text = (ctx: Ctx, t: string) => reply(ctx, { kind: 'text', text: t });

export const MENU_BUTTON = { id: 'menu', title: '🏠 Main menu' };
export const HUMAN_BUTTON = { id: 'human', title: '🙋 Talk to us' };
export const BOOK_BUTTON = { id: 'book', title: '⚽ Book a turf' };

/** Normalises text for loose comparisons (drops emoji/punctuation). */
export const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Builds list rows with ◀/▶ paging rows so we never exceed WhatsApp's 10-row limit. */
export function paged<T>(
  items: T[],
  page: number,
  toRow: (item: T) => { id: string; title: string; description?: string },
  pageId: (page: number) => string,
  reserve = 0,
) {
  const max = 10 - reserve;
  if (items.length <= max) return { rows: items.map(toRow), page: 0, pages: 1 };
  const size = max - 2;
  const pages = Math.ceil(items.length / size);
  const p = Math.max(0, Math.min(page, pages - 1));
  const rows = items.slice(p * size, p * size + size).map(toRow);
  if (p > 0) rows.unshift({ id: pageId(p - 1), title: '◀ Previous', description: `Page ${p} of ${pages}` });
  if (p < pages - 1) rows.push({ id: pageId(p + 1), title: '▶ More', description: `Page ${p + 2} of ${pages}` });
  return { rows, page: p, pages };
}
