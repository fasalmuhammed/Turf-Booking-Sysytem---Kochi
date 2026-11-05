// Must be imported first by every test file: configures an isolated in-memory environment.
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.WHATSAPP_MODE = 'mock';
process.env.TZ_NAME = 'Asia/Kolkata';
process.env.APP_SECRET = 'test-secret-0123456789';
process.env.WHATSAPP_APP_SECRET = 'wa-app-secret';
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
process.env.PUBLIC_BASE_URL = 'https://turf.example.test';
process.env.ADMIN_WHATSAPP_NUMBERS = '919000000001';
process.env.SEED_DEMO_DATA = 'false';
process.env.RAZORPAY_WEBHOOK_SECRET = 'rzp-secret';
