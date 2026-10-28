import pino from 'pino';
import { z } from 'zod';
import { createDb } from '@ohviana/db';
import { HANDLERS } from './handlers';
import {
  findSeatMismatches,
  outboxStats,
  purgeDeliveredOutbox,
  purgeExpiredIdempotencyKeys,
} from './maintenance';
import { LogNotifier, ResendNotifier, type Notifier } from './notifier';
import { processOutboxBatch } from './outbox';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  PUBLIC_SITE_URL: z.url().default('http://localhost:3000'),
  ADMIN_NOTIFY_EMAIL: z.email().optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().default('Ohviana <bookings@ohviana.in>'),
  WORKER_POLL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),
  MAINTENANCE_EVERY_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(15 * 60_000),
});

const env = Env.parse(process.env);
const log = pino({
  level: env.LOG_LEVEL,
  base: { service: 'ohviana-worker' },
  ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
});

if (env.NODE_ENV === 'production' && !env.RESEND_API_KEY) {
  log.warn('RESEND_API_KEY is not set: emails will be logged, not sent');
}
const notifier: Notifier = env.RESEND_API_KEY
  ? new ResendNotifier(env.RESEND_API_KEY, env.EMAIL_FROM)
  : new LogNotifier(log);

const { db, close } = createDb(env.DATABASE_URL, { max: 3, applicationName: 'ohviana-worker' });
const ctx = {
  db,
  notifier,
  siteUrl: env.PUBLIC_SITE_URL.replace(/\/+$/, ''),
  adminEmail: env.ADMIN_NOTIFY_EMAIL ?? null,
};

let stopping = false;
let lastMaintenance = 0;

async function maintenance() {
  const [keys, outbox, mismatches, stats] = await Promise.all([
    purgeExpiredIdempotencyKeys(db),
    purgeDeliveredOutbox(db),
    findSeatMismatches(db),
    outboxStats(db),
  ]);
  log.info(
    { purgedIdempotencyKeys: keys, purgedOutbox: outbox, outbox: stats },
    'maintenance done',
  );
  if (mismatches.length > 0) {
    // Alert-worthy: inventory counters disagree with bookings.
    log.error({ mismatches }, 'INVENTORY DISCREPANCY: batch seat counters differ from bookings');
  }
  if (stats.dead > 0) log.error({ dead: stats.dead }, 'outbox has dead-lettered events');
}

async function loop() {
  log.info(
    { pollMs: env.WORKER_POLL_MS, email: env.RESEND_API_KEY ? 'resend' : 'log' },
    'worker started',
  );
  while (!stopping) {
    try {
      const r = await processOutboxBatch(ctx, HANDLERS, {
        onUnknownTopic: (topic) =>
          log.warn({ topic }, 'no handler for outbox topic; marked processed'),
        onError: (row, err) =>
          log.warn(
            { eventId: row.id, topic: row.topic, attempts: row.attempts + 1, err },
            'outbox delivery failed',
          ),
      });
      if (r.claimed > 0) log.info(r, 'outbox batch');
      if (Date.now() - lastMaintenance > env.MAINTENANCE_EVERY_MS) {
        lastMaintenance = Date.now();
        await maintenance();
      }
      // Drain quickly while there is work; otherwise poll.
      if (r.claimed === 0) await new Promise((res) => setTimeout(res, env.WORKER_POLL_MS));
    } catch (err) {
      log.error({ err }, 'worker iteration failed');
      await new Promise((res) => setTimeout(res, env.WORKER_POLL_MS * 5));
    }
  }
  await close();
  log.info('worker stopped');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'stopping after current batch');
    stopping = true;
  });
}

void loop();
