import './setup.js';
import { openDatabase, run } from '../src/db/index.js';
import { clearSettingsCache } from '../src/services/settings.js';
import { createLocation, createTurf } from '../src/services/catalog.js';
import { upsertCustomer } from '../src/services/customers.js';
import { getTransport, MockTransport } from '../src/whatsapp/client.js';
import { handleInbound } from '../src/bot/engine.js';
import type { OutboundMessage } from '../src/whatsapp/types.js';

openDatabase(':memory:');

export function resetDb() {
  for (const t of ['payments', 'bookings', 'slot_blocks', 'offers', 'price_rules', 'turfs', 'locations', 'customers', 'chat_sessions', 'messages', 'faqs', 'settings', 'admin_sessions', 'admins', 'audit_log']) {
    run(`DELETE FROM ${t}`);
  }
  clearSettingsCache();
  mock().clear();
}

export function makeTurf(overrides: Partial<Parameters<typeof createTurf>[0]> = {}) {
  const loc = createLocation({ name: 'Test Arena', address: 'Somewhere', maps_url: '', contact_phone: '' });
  const id = createTurf({
    location_id: loc,
    name: 'Turf A',
    sports: 'Football',
    description: '',
    open_minute: 360,
    close_minute: 1380,
    slot_minutes: 60,
    base_price: 1000,
    advance_percent: 30,
    max_slots_per_booking: 3,
    closed_days: '',
    sort_order: 0,
    active: true,
    ...overrides,
  });
  return { locationId: loc, turfId: id };
}

export const makeCustomer = (phone = '919876543210', name = 'Ravi') => upsertCustomer(phone, name);

export const mock = () => getTransport() as MockTransport;

let seq = 0;
/** Sends a text (or button/list reply when replyId is given) and returns the bot's replies to it. */
export async function say(phone: string, text: string, replyId = '', name = 'Ravi Kumar'): Promise<OutboundMessage[]> {
  const before = mock().outbox.get(phone)?.length ?? 0;
  await handleInbound({
    from: phone,
    id: `t.${++seq}.${Date.now()}`,
    profileName: name,
    timestamp: Date.now(),
    kind: replyId ? 'reply' : 'text',
    text,
    replyId,
    rawType: replyId ? 'interactive' : 'text',
  });
  return (mock().outbox.get(phone) ?? []).slice(before).map((m) => m.msg);
}

export const tap = (phone: string, id: string) => say(phone, '', id);

/** All reply ids offered by a set of messages (buttons + list rows). */
export function optionIds(msgs: OutboundMessage[]): string[] {
  return msgs.flatMap((m) => (m.kind === 'buttons' ? m.buttons.map((b) => b.id) : m.kind === 'list' ? m.sections.flatMap((s) => s.rows.map((r) => r.id)) : []));
}

export function bodyText(msgs: OutboundMessage[]): string {
  return msgs.map((m) => (m.kind === 'text' ? m.text : m.kind === 'template' ? m.fallbackText : m.body)).join('\n---\n');
}
