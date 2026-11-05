import { adminCount, createAdmin, passwordProblems } from './admin/auth.js';
import { createApp } from './app.js';
import { assertProductionConfig, config } from './config.js';
import { closeDatabase, openDatabase } from './db/index.js';
import { seedDemoData } from './db/seed.js';
import { startScheduler, stopScheduler } from './services/scheduler.js';

openDatabase(config.databasePath);

if (config.seedDemoData && seedDemoData()) console.log('🌱 Loaded demo turfs, offers and FAQs (edit them in the dashboard).');

if (adminCount() === 0) {
  const { username, password } = config.initialAdmin;
  const problem = password ? passwordProblems(password) : 'ADMIN_PASSWORD is not set';
  if (problem) {
    console.warn(`⚠️  No admin account exists and one could not be created: ${problem}.`);
    console.warn('    Set ADMIN_USERNAME / ADMIN_PASSWORD in .env, or run: npm run create-admin -- <username> <password>');
  } else {
    createAdmin(username, password);
    console.log(`👤 Created admin account "${username}" from .env (you can remove ADMIN_PASSWORD from .env now).`);
  }
}

const problems = assertProductionConfig();
if (problems.length) {
  const log = config.isProduction ? console.error : console.warn;
  for (const p of problems) log(`⚠️  ${p}`);
  if (config.isProduction) {
    console.error('Refusing to start in production with insecure configuration.');
    process.exit(1);
  }
}

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`\n⚽ Turf booking server running on http://localhost:${config.port}`);
  console.log(`   Admin dashboard: http://localhost:${config.port}/admin`);
  console.log(`   WhatsApp webhook: ${config.publicBaseUrl}/webhooks/whatsapp  (mode: ${config.whatsapp.mode})`);
  if (config.whatsapp.mode === 'mock') console.log('   Mock mode: chat with the bot at /admin/simulator');
});

startScheduler();

function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down…`);
  stopScheduler();
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
