import { config } from '../config.js';
import { run } from '../db/index.js';
import { truncate } from '../utils/misc.js';
import { LIMITS, renderPlain, type OutboundMessage } from './types.js';

export interface WhatsAppTransport {
  send(to: string, msg: OutboundMessage): Promise<string | null>;
  markRead?(messageId: string): Promise<void>;
}

/** Converts our message shape into a Cloud API payload, enforcing Meta's length limits. */
export function toCloudPayload(to: string, m: OutboundMessage): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  const header = (h?: string) => (h ? { header: { type: 'text', text: truncate(h, LIMITS.header) } } : {});
  const footer = (f?: string) => (f ? { footer: { text: truncate(f, LIMITS.footer) } } : {});
  switch (m.kind) {
    case 'text':
      return { ...base, type: 'text', text: { body: truncate(m.text, LIMITS.text), preview_url: true } };
    case 'buttons':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          ...header(m.header),
          body: { text: truncate(m.body, LIMITS.body) },
          ...footer(m.footer),
          action: {
            buttons: m.buttons.slice(0, LIMITS.maxButtons).map((b) => ({
              type: 'reply',
              reply: { id: b.id.slice(0, LIMITS.replyId), title: truncate(b.title, LIMITS.buttonTitle) },
            })),
          },
        },
      };
    case 'list': {
      let budget = LIMITS.maxRows;
      const sections = m.sections
        .map((s) => {
          const rows = s.rows.slice(0, Math.max(0, budget));
          budget -= rows.length;
          return {
            ...(s.title ? { title: truncate(s.title, LIMITS.sectionTitle) } : {}),
            rows: rows.map((r) => ({
              id: r.id.slice(0, LIMITS.replyId),
              title: truncate(r.title, LIMITS.rowTitle),
              ...(r.description ? { description: truncate(r.description, LIMITS.rowDescription) } : {}),
            })),
          };
        })
        .filter((s) => s.rows.length > 0);
      // Meta requires section titles when there is more than one section
      if (sections.length > 1) sections.forEach((s, i) => ((s as { title?: string }).title ??= `Options ${i + 1}`));
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'list',
          ...header(m.header),
          body: { text: truncate(m.body, LIMITS.body) },
          ...footer(m.footer),
          action: { button: truncate(m.button, LIMITS.listButton), sections },
        },
      };
    }
    case 'cta':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          ...header(m.header),
          body: { text: truncate(m.body, LIMITS.body) },
          ...footer(m.footer),
          action: { name: 'cta_url', parameters: { display_text: truncate(m.displayText, LIMITS.buttonTitle), url: m.url } },
        },
      };
    case 'template':
      return {
        ...base,
        type: 'template',
        template: {
          name: m.name,
          language: { code: m.lang },
          components: m.params.length ? [{ type: 'body', parameters: m.params.map((text) => ({ type: 'text', text })) }] : [],
        },
      };
  }
}

export class CloudApiTransport implements WhatsAppTransport {
  private url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;

  private async post(payload: Record<string, unknown>, attempt = 1): Promise<Record<string, unknown>> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.whatsapp.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // retry transient errors (rate limit / server errors) with backoff
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 500 * attempt * attempt));
        return this.post(payload, attempt + 1);
      }
      throw new Error(`WhatsApp API ${res.status}: ${JSON.stringify(json.error ?? json)}`);
    }
    return json;
  }

  async send(to: string, msg: OutboundMessage): Promise<string | null> {
    const json = await this.post(toCloudPayload(to, msg));
    const messages = json.messages as { id: string }[] | undefined;
    return messages?.[0]?.id ?? null;
  }

  async markRead(messageId: string) {
    await this.post({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }).catch(() => undefined);
  }
}

/** In-memory transport for local development and the dashboard simulator. */
export class MockTransport implements WhatsAppTransport {
  outbox = new Map<string, { id: string; at: number; msg: OutboundMessage }[]>();
  private seq = 0;

  async send(to: string, msg: OutboundMessage) {
    const id = `mock.${Date.now()}.${++this.seq}`;
    const list = this.outbox.get(to) ?? [];
    list.push({ id, at: Date.now(), msg });
    if (list.length > 200) list.splice(0, list.length - 200);
    this.outbox.set(to, list);
    if (!config.isProduction && process.env.NODE_ENV !== 'test') {
      console.log(`\n📤 → ${to}\n${renderPlain(msg).replace(/^/gm, '   ')}`);
    }
    return id;
  }

  clear(to?: string) {
    if (to) this.outbox.delete(to);
    else this.outbox.clear();
  }
}

let transport: WhatsAppTransport =
  config.whatsapp.mode === 'cloud' ? new CloudApiTransport() : new MockTransport();

export const getTransport = () => transport;
export const setTransport = (t: WhatsAppTransport) => {
  transport = t;
};
export const isMock = () => transport instanceof MockTransport;

/** Sends a message and records it in the conversation log. Never throws. */
export async function sendMessage(to: string, msg: OutboundMessage, opts: { adminId?: number } = {}): Promise<boolean> {
  let waId: string | null = null;
  let ok = true;
  try {
    waId = await transport.send(to, msg);
  } catch (err) {
    ok = false;
    console.error(`[whatsapp] send to ${to} failed:`, (err as Error).message);
  }
  try {
    run(
      `INSERT INTO messages (phone, direction, wa_message_id, type, body, sent_by_admin, created_at) VALUES (?, 'out', ?, ?, ?, ?, ?)`,
      to,
      waId,
      ok ? msg.kind : `${msg.kind}:failed`,
      renderPlain(msg),
      opts.adminId ?? null,
      Date.now(),
    );
  } catch (err) {
    console.error('[whatsapp] failed to log message', err);
  }
  return ok;
}
