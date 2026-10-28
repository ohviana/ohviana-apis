import { sql } from 'drizzle-orm';
import type { Database } from '@ohviana/db';

/** Idempotency keys are only needed for 24h of client retries. */
export async function purgeExpiredIdempotencyKeys(db: Database): Promise<number> {
  const rows = await db.execute(
    sql`delete from idempotency_keys where expires_at < now() returning 1`,
  );
  return rows.length;
}

/** Delivered outbox events older than 30 days are history, not work. */
export async function purgeDeliveredOutbox(db: Database, olderThanDays = 30): Promise<number> {
  const rows = await db.execute(sql`
    delete from outbox_events
    where processed_at is not null and processed_at < now() - make_interval(days => ${olderThanDays})
    returning 1`);
  return rows.length;
}

export interface SeatMismatch {
  batchId: string;
  recordedSeats: number;
  bookedSeats: number;
}

/**
 * Inventory reconciliation (TDD §7): `batches.confirmed_seats` must equal the seats of its
 * confirmed bookings. Any mismatch means a bug or manual edit and must be investigated.
 * Cancelled batches are excluded (their counter is reset to 0 by design).
 */
export async function findSeatMismatches(db: Database): Promise<SeatMismatch[]> {
  const rows = await db.execute<{ batch_id: string; recorded: number; booked: number }>(sql`
    select b.id as batch_id, b.confirmed_seats as recorded,
           coalesce(sum(k.quantity) filter (where k.status = 'confirmed'), 0)::int as booked
    from batches b
    left join bookings k on k.batch_id = b.id
    where b.status <> 'cancelled'
    group by b.id
    having b.confirmed_seats <> coalesce(sum(k.quantity) filter (where k.status = 'confirmed'), 0)`);
  return rows.map((r) => ({
    batchId: r.batch_id,
    recordedSeats: r.recorded,
    bookedSeats: r.booked,
  }));
}

/** Health signals for monitoring: backlog, oldest pending age, dead letters. */
export async function outboxStats(db: Database) {
  const [row] = await db.execute<{
    pending: number;
    dead: number;
    oldest_seconds: number | null;
  }>(sql`
    select
      count(*) filter (where processed_at is null and available_at <> 'infinity')::int as pending,
      count(*) filter (where processed_at is null and available_at = 'infinity')::int as dead,
      extract(epoch from now() - min(created_at) filter (where processed_at is null and available_at <> 'infinity'))::int as oldest_seconds
    from outbox_events`);
  return {
    pending: row?.pending ?? 0,
    dead: row?.dead ?? 0,
    oldestPendingSeconds: row?.oldest_seconds ?? 0,
  };
}
