import { run } from '../db/index.js';
import { sendHoldExpired, sendReminder } from '../bot/notify.js';
import { completeFinished, dueReminders, expireHolds, markReminderSent } from './bookings.js';

let timer: NodeJS.Timeout | null = null;
let running = false;

/** One pass of all periodic jobs. Exported for tests. */
export async function runJobs(nowMs = Date.now()) {
  if (running) return;
  running = true;
  try {
    for (const b of expireHolds(nowMs)) {
      await sendHoldExpired(b);
    }
    completeFinished(nowMs);
    for (const b of dueReminders(nowMs)) {
      markReminderSent(b.id, nowMs); // mark first so a failure never causes duplicate reminders
      await sendReminder(b);
    }
    run('DELETE FROM admin_sessions WHERE expires_at < ?', nowMs);
  } catch (err) {
    console.error('[scheduler] job failed', err);
  } finally {
    running = false;
  }
}

export function startScheduler(intervalMs = 60_000) {
  if (timer) return;
  void runJobs();
  timer = setInterval(() => void runJobs(), intervalMs);
  timer.unref();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
