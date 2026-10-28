import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './_helpers';

/**
 * Transactional outbox: written in the same transaction as the domain change, then delivered
 * (email/SMS/WhatsApp) by a worker with retries. Guarantees no lost or phantom notifications.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: id(),
    topic: text('topic').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    availableAt: ts('available_at').notNull().defaultNow(),
    processedAt: ts('processed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('outbox_pending_idx')
      .on(t.availableAt)
      .where(sql`${t.processedAt} is null`),
  ],
).enableRLS();
