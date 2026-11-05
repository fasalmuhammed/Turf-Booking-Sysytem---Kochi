import { all, run } from '../db/index.js';

/** Every editable business setting, with its default value. */
export const SETTING_DEFAULTS = {
  business_name: 'PlayZone Turfs',
  welcome_message:
    "Book your game in under a minute — no calls needed. Pick a turf, choose a slot, pay via UPI and you're on the field! ⚽🏏",
  upi_vpa: '',
  upi_payee_name: '',
  support_phone: '',
  booking_window_days: '7',
  hold_minutes: '15',
  min_lead_minutes: '30',
  allow_advance_payment: 'true',
  free_cancel_hours: '24',
  late_cancel_refund_percent: '50',
  cancel_cutoff_hours: '2',
  reschedule_cutoff_hours: '6',
  max_reschedules: '1',
  reminder_hours_before: '3',
  turf_rules:
    '• Non-marking studs or sports shoes only\n• Please arrive 10 minutes before your slot\n• No smoking or alcohol on the premises\n• Management is not responsible for personal belongings',
  handoff_message: 'Our team has been notified and will reply here shortly. 🙏 (Reply *menu* any time to go back to the bot.)',
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

let cache: Record<string, string> | null = null;

function load(): Record<string, string> {
  if (!cache) {
    cache = { ...SETTING_DEFAULTS };
    for (const row of all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
      cache[row.key] = row.value;
    }
  }
  return cache;
}

export function getSetting(key: SettingKey): string {
  return load()[key] ?? SETTING_DEFAULTS[key];
}

export function getNumber(key: SettingKey): number {
  const n = Number(getSetting(key));
  return Number.isFinite(n) ? n : Number(SETTING_DEFAULTS[key]);
}

export function getBool(key: SettingKey): boolean {
  return getSetting(key) === 'true';
}

export function getAllSettings(): Record<SettingKey, string> {
  return { ...load() } as Record<SettingKey, string>;
}

export function setSettings(values: Partial<Record<SettingKey, string>>) {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in SETTING_DEFAULTS) || value === undefined) continue;
    run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }
  cache = null;
}

export function clearSettingsCache() {
  cache = null;
}
