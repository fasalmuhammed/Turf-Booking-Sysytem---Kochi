/** Outbound messages in a transport-neutral shape. */
export type OutboundMessage =
  | { kind: 'text'; text: string }
  | { kind: 'buttons'; body: string; header?: string; footer?: string; buttons: { id: string; title: string }[] }
  | {
      kind: 'list';
      body: string;
      header?: string;
      footer?: string;
      button: string;
      sections: { title: string; rows: { id: string; title: string; description?: string }[] }[];
    }
  | { kind: 'cta'; body: string; header?: string; footer?: string; displayText: string; url: string }
  | { kind: 'template'; name: string; lang: string; params: string[]; fallbackText: string };

export interface InboundMessage {
  from: string;
  id: string;
  profileName: string;
  timestamp: number;
  /** text = free text; reply = button/list selection; other = media/location/etc. */
  kind: 'text' | 'reply' | 'other';
  text: string;
  replyId: string;
  rawType: string;
  /** media id for image/document messages (e.g. payment screenshots) */
  mediaId?: string;
}

/** WhatsApp Cloud API limits for interactive messages. */
export const LIMITS = {
  body: 1024,
  text: 4096,
  header: 60,
  footer: 60,
  buttonTitle: 20,
  maxButtons: 3,
  listButton: 20,
  rowTitle: 24,
  rowDescription: 72,
  sectionTitle: 24,
  maxRows: 10,
  replyId: 256,
};

/** Plain-text rendering used for the conversation log and as a fallback. */
export function renderPlain(m: OutboundMessage): string {
  switch (m.kind) {
    case 'text':
      return m.text;
    case 'buttons':
      return [m.header, m.body, m.footer, m.buttons.map((b) => `[${b.title}]`).join(' ')].filter(Boolean).join('\n');
    case 'list':
      return [
        m.header,
        m.body,
        m.footer,
        `☰ ${m.button}`,
        ...m.sections.flatMap((s) => [s.title ? `— ${s.title} —` : '', ...s.rows.map((r) => `• ${r.title}${r.description ? ` (${r.description})` : ''}`)]),
      ]
        .filter(Boolean)
        .join('\n');
    case 'cta':
      return [m.header, m.body, m.footer, `🔗 ${m.displayText}: ${m.url}`].filter(Boolean).join('\n');
    case 'template':
      return m.fallbackText;
  }
}
