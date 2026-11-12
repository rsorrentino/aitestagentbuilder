/**
 * Background jobs started with the API server:
 *   - scheduler tick every SCHEDULER_INTERVAL_SECONDS (default 30; SCHEDULER_ENABLED=false to disable)
 *   - retention once an hour (and shortly after start)
 *   - notifications subscribed to run events
 *   - sign-in health: warnings before sessions saved by a person expire (hourly)
 *   - daily digests at each channel's time (checked every 5 minutes)
 *
 * Every job is safe to run on several replicas at once.
 */

import logger from '../../infra/logger/index.js';
import { ScheduleService } from './schedule.service.js';
import { applyRetention } from './retention.service.js';
import { wireNotifications } from './notification.service.js';
import { warnExpiringSessions } from '../auth/health.js';
import { sendDueDigests } from './digest.js';

const timers: NodeJS.Timeout[] = [];
let wired = false;
let ticking = false;

export function startBackgroundJobs(): void {
  if (!wired) {
    wireNotifications();
    wired = true;
  }

  if (process.env.SCHEDULER_ENABLED !== 'false') {
    const schedules = new ScheduleService();
    const interval = Math.max(5, parseInt(process.env.SCHEDULER_INTERVAL_SECONDS || '30')) * 1000;
    timers.push(setInterval(async () => {
      if (ticking) return;
      ticking = true;
      try {
        await schedules.tick();
      } catch (error: any) {
        logger.error('Scheduler error', { error: error.message });
      } finally {
        ticking = false;
      }
    }, interval));
    logger.info(`Scheduler running every ${interval / 1000}s`);
  }

  const retention = () => applyRetention().catch((e) => logger.error('Retention failed', { error: e.message }));
  timers.push(setTimeout(retention, 60_000));
  timers.push(setInterval(retention, 3_600_000));
  const sessions = () => warnExpiringSessions().catch((e) => logger.error('Session expiry check failed', { error: e.message }));
  timers.push(setTimeout(sessions, 120_000));
  timers.push(setInterval(sessions, 3_600_000));
  const digests = () => sendDueDigests().catch((e) => logger.error('Digest check failed', { error: e.message }));
  timers.push(setInterval(digests, 300_000));
  timers.forEach((t) => t.unref());
}

export function stopBackgroundJobs(): void {
  while (timers.length) {
    const t = timers.pop()!;
    clearInterval(t);
    clearTimeout(t);
  }
}
