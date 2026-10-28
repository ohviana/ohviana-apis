import { eq, inArray, sql } from 'drizzle-orm';
import { outboxEvents, type Database } from '@ohviana/db';
import type { Handler, HandlerContext } from './handlers';

/** After this many failures an event is parked (dead letter) for a human to look at. */
export const MAX_ATTEMPTS = 8;
/** How long a claimed event stays invisible to other workers while being processed. */
const LEASE_SECONDS = 300;

/** 30s, 1m, 2m, 4m … capped at 1h. */
export function backoffSeconds(attempts: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
}

export interface BatchResult {
  claimed: number;
  delivered: number;
  failed: number;
  dead: number;
}

type Row = typeof outboxEvents.$inferSelect;

/**
 * Claims due events with FOR UPDATE SKIP LOCKED and a lease (pushes available_at forward), so
 * several workers can run safely without long transactions; then processes each and records
 * success, retry-with-backoff, or dead letter.
 */
export async function processOutboxBatch(
  ctx: HandlerContext,
  handlers: Record<string, Handler>,
  opts: {
    limit?: number;
    /** Only claim these topics (e.g. a dedicated worker, or tests on a shared database). */
    topics?: string[];
    onUnknownTopic?: (topic: string) => void;
    onError?: (row: Row, err: unknown) => void;
  } = {},
): Promise<BatchResult> {
  const db: Database = ctx.db;
  const claimed = await db.execute<{ id: string }>(sql`
    with due as (
      select id from ${outboxEvents}
      where processed_at is null and available_at <= now()
        ${opts.topics ? sql`and ${inArray(outboxEvents.topic, opts.topics)}` : sql``}
      order by available_at
      limit ${opts.limit ?? 20}
      for update skip locked
    )
    update ${outboxEvents} o
    set available_at = now() + make_interval(secs => ${LEASE_SECONDS})
    from due where o.id = due.id
    returning o.id`);

  const result: BatchResult = { claimed: claimed.length, delivered: 0, failed: 0, dead: 0 };
  for (const { id } of claimed) {
    const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, id));
    if (!row) continue;
    const handler = handlers[row.topic];
    try {
      if (handler) await handler(ctx, row.payload);
      else opts.onUnknownTopic?.(row.topic);
      await db
        .update(outboxEvents)
        .set({ processedAt: new Date(), lastError: null })
        .where(eq(outboxEvents.id, id));
      result.delivered++;
    } catch (err) {
      opts.onError?.(row, err);
      const attempts = row.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await db
        .update(outboxEvents)
        .set({
          attempts,
          lastError: String(err instanceof Error ? err.message : err).slice(0, 1000),
          // 'infinity' parks the event: never due again until someone resets it.
          availableAt: dead
            ? sql`'infinity'::timestamptz`
            : sql`now() + make_interval(secs => ${backoffSeconds(attempts)})`,
        })
        .where(eq(outboxEvents.id, id));
      if (dead) result.dead++;
      else result.failed++;
    }
  }
  return result;
}
