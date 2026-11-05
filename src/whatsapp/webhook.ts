import crypto from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { config } from '../config.js';
import { safeEqual } from '../utils/misc.js';
import type { InboundMessage } from './types.js';

interface CloudMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  button?: { payload: string; text: string };
  image?: { id: string; caption?: string };
  document?: { id: string; filename?: string; caption?: string };
}

/** Extracts the messages we care about from a Cloud API webhook payload. */
export function parseWebhook(body: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const entries = (body as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries as { changes?: { value?: Record<string, unknown> }[] }[]) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const contacts = (value.contacts as { wa_id: string; profile?: { name?: string } }[] | undefined) ?? [];
      const names = new Map(contacts.map((c) => [c.wa_id, c.profile?.name ?? '']));
      for (const m of (value.messages as CloudMessage[] | undefined) ?? []) {
        const base = {
          from: m.from,
          id: m.id,
          profileName: names.get(m.from) ?? '',
          timestamp: Number(m.timestamp) * 1000 || Date.now(),
          rawType: m.type,
        };
        if (m.type === 'text' && m.text) {
          out.push({ ...base, kind: 'text', text: m.text.body, replyId: '' });
        } else if (m.type === 'interactive' && m.interactive) {
          const r = m.interactive.button_reply ?? m.interactive.list_reply;
          out.push({ ...base, kind: 'reply', text: r?.title ?? '', replyId: r?.id ?? '' });
        } else if (m.type === 'button' && m.button) {
          // quick-reply button on a template message
          out.push({ ...base, kind: 'reply', text: m.button.text, replyId: m.button.payload });
        } else if (m.type === 'image' || m.type === 'document') {
          const media = m.image ?? m.document;
          out.push({ ...base, kind: 'other', text: media?.caption ?? '', replyId: '', mediaId: media?.id });
        } else {
          out.push({ ...base, kind: 'other', text: '', replyId: '' });
        }
      }
    }
  }
  return out;
}

export function verifySignature(rawBody: Buffer | undefined, header: string | undefined): boolean {
  if (!config.whatsapp.appSecret) return !config.isProduction && config.whatsapp.mode !== 'cloud';
  if (!rawBody || !header?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', config.whatsapp.appSecret).update(rawBody).digest('hex');
  return safeEqual(expected, header);
}

export function whatsappWebhookRouter(onMessage: (m: InboundMessage) => Promise<void>) {
  const router = express.Router();

  // Meta's one-time verification handshake
  router.get('/', (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && typeof token === 'string' && safeEqual(token, config.whatsapp.verifyToken)) {
      res.status(200).type('text/plain').send(String(challenge ?? ''));
    } else {
      res.sendStatus(403);
    }
  });

  router.post('/', (req: Request, res: Response) => {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!verifySignature(raw, req.header('x-hub-signature-256'))) {
      console.warn('[webhook] rejected request with invalid signature');
      res.sendStatus(401);
      return;
    }
    // Acknowledge immediately — Meta retries if we take too long
    res.sendStatus(200);
    for (const m of parseWebhook(req.body)) {
      onMessage(m).catch((err) => console.error('[webhook] handler error', err));
    }
  });

  return router;
}
