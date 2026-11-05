import { all, get, run } from '../db/index.js';

export interface SessionData {
  locationId?: number;
  turfId?: number;
  date?: string;
  start?: number;
  slots?: number;
  name?: string;
  phone?: string;
  paymentOption?: 'advance' | 'full';
  bookingCode?: string;
  /** options from the last interactive message so typed numbers/titles still work */
  options?: { id: string; title: string }[];
}

export type BotState =
  | 'idle'
  | 'choose_location'
  | 'choose_turf'
  | 'choose_date'
  | 'choose_slot'
  | 'choose_duration'
  | 'ask_name'
  | 'enter_name'
  | 'ask_phone'
  | 'enter_phone'
  | 'confirm_summary'
  | 'choose_payment'
  | 'awaiting_payment'
  | 'enter_utr'
  | 'my_bookings'
  | 'faq';

export interface Session {
  phone: string;
  state: BotState;
  data: SessionData;
  mode: 'bot' | 'human';
  human_requested_at: number | null;
  last_inbound_at: number | null;
  updated_at: number;
}

interface Row {
  phone: string;
  state: string;
  data: string;
  mode: 'bot' | 'human';
  human_requested_at: number | null;
  last_inbound_at: number | null;
  updated_at: number;
}

export function loadSession(phone: string): Session {
  const row = get<Row>('SELECT * FROM chat_sessions WHERE phone = ?', phone);
  if (!row) {
    return { phone, state: 'idle', data: {}, mode: 'bot', human_requested_at: null, last_inbound_at: null, updated_at: 0 };
  }
  let data: SessionData = {};
  try {
    data = JSON.parse(row.data) as SessionData;
  } catch {
    /* corrupted → start fresh */
  }
  return { ...row, state: row.state as BotState, data };
}

export function saveSession(s: Session) {
  s.updated_at = Date.now();
  run(
    `INSERT INTO chat_sessions (phone, state, data, mode, human_requested_at, last_inbound_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET state = excluded.state, data = excluded.data, mode = excluded.mode,
       human_requested_at = excluded.human_requested_at, last_inbound_at = excluded.last_inbound_at, updated_at = excluded.updated_at`,
    s.phone,
    s.state,
    JSON.stringify(s.data),
    s.mode,
    s.human_requested_at,
    s.last_inbound_at,
    s.updated_at,
  );
}

export function setMode(phone: string, mode: 'bot' | 'human') {
  const s = loadSession(phone);
  s.mode = mode;
  s.human_requested_at = mode === 'human' ? Date.now() : null;
  if (mode === 'bot') s.state = 'idle';
  saveSession(s);
}

/** True if we can send free-form messages (customer messaged within the last 24h). */
export function inServiceWindow(phone: string, nowMs = Date.now()): boolean {
  const row = get<{ last_inbound_at: number | null }>('SELECT last_inbound_at FROM chat_sessions WHERE phone = ?', phone);
  return Boolean(row?.last_inbound_at && nowMs - row.last_inbound_at < 24 * 3_600_000 - 5 * 60_000);
}

export const humanQueue = () =>
  all<Row & { name: string; whatsapp_name: string; last_message: string | null }>(
    `SELECT s.*, c.name, c.whatsapp_name,
            (SELECT body FROM messages m WHERE m.phone = s.phone AND m.direction = 'in' ORDER BY m.id DESC LIMIT 1) AS last_message
       FROM chat_sessions s LEFT JOIN customers c ON c.phone = s.phone
      WHERE s.mode = 'human' ORDER BY s.human_requested_at`,
  );
