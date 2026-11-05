function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export const config = {
  port: Number(env('PORT', '3000')),
  isProduction: env('NODE_ENV', 'development') === 'production',
  publicBaseUrl: env('PUBLIC_BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  timeZone: env('TZ_NAME', 'Asia/Kolkata'),
  databasePath: env('DATABASE_PATH', './data/turf.db'),
  appSecret: env('APP_SECRET', 'dev-insecure-secret'),

  whatsapp: {
    mode: env('WHATSAPP_MODE', 'mock') as 'mock' | 'cloud',
    token: env('WHATSAPP_TOKEN'),
    phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
    apiVersion: env('WHATSAPP_API_VERSION', 'v21.0'),
    verifyToken: env('WHATSAPP_VERIFY_TOKEN', 'choose-a-verify-token'),
    appSecret: env('WHATSAPP_APP_SECRET'),
    reminderTemplate: env('WHATSAPP_REMINDER_TEMPLATE'),
    templateLang: env('WHATSAPP_TEMPLATE_LANG', 'en'),
  },

  adminNumbers: env('ADMIN_WHATSAPP_NUMBERS')
    .split(',')
    .map((s) => s.replace(/\D/g, ''))
    .filter(Boolean),

  razorpay: {
    keyId: env('RAZORPAY_KEY_ID'),
    keySecret: env('RAZORPAY_KEY_SECRET'),
    webhookSecret: env('RAZORPAY_WEBHOOK_SECRET'),
  },

  initialAdmin: {
    username: env('ADMIN_USERNAME', 'admin'),
    password: env('ADMIN_PASSWORD'),
  },
  seedDemoData: bool('SEED_DEMO_DATA', true),
};

export const razorpayEnabled = () =>
  Boolean(config.razorpay.keyId && config.razorpay.keySecret);

export function assertProductionConfig(): string[] {
  const problems: string[] = [];
  if (config.appSecret === 'dev-insecure-secret' || config.appSecret.startsWith('change-me')) {
    problems.push('APP_SECRET is not set to a strong random value');
  }
  if (config.whatsapp.mode === 'cloud') {
    if (!config.whatsapp.token) problems.push('WHATSAPP_TOKEN is missing');
    if (!config.whatsapp.phoneNumberId) problems.push('WHATSAPP_PHONE_NUMBER_ID is missing');
    if (!config.whatsapp.appSecret) problems.push('WHATSAPP_APP_SECRET is missing (webhook signatures cannot be verified)');
  }
  return problems;
}
