import { and, asc, eq, gte, inArray, lte, notInArray, sql, type SQL } from 'drizzle-orm';
import {
  batchPickups,
  batches,
  bookingEvents,
  bookings,
  catalogTreks,
  directLinks,
  organizers,
  organizerTreks,
  pgConstraintName,
  pgErrorCode,
  PG_FOREIGN_KEY_VIOLATION,
  pickupPoints,
  type Database,
  type Tx,
} from '@ohviana/db';
import type {
  BulkCreateBatchesRequest,
  CreateBatchRequest,
  DashboardSummary,
  OrganizerBatch,
  OrganizerBatchListQuery,
  RepeatBatchRequest,
  UpdateBatchRequest,
} from '@ohviana/contracts';
import { BATCH_VIEWS, batchName, deriveBatchView, type BatchView } from '@ohviana/shared';
import { enqueueEvent } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { decodeCursor, toPage } from '../../lib/pagination';
import { onLeadsSaved } from './leads.service';
import { newDirectLinkToken } from './links.service';
import { getTrekRow } from './treks.service';

type Executor = Database | Tx;
type BatchRow = typeof batches.$inferSelect;

/**
 * SQL twin of `deriveBatchView` (shared/domain.ts). Keep the two in step: the dashboard filters
 * with this expression and displays the JS one.
 */
export function batchViewSql(now: Date): SQL<BatchView> {
  const t = sql`${now.toISOString()}::timestamptz`;
  return sql<BatchView>`case
    when ${batches.status} in ('draft', 'cancelled', 'completed') then ${batches.status}
    when ${t} >= ${batches.returnAt} then 'completed'
    when ${t} >= ${batches.departureAt} then 'ongoing'
    when ${batches.confirmedSeats} >= ${batches.capacity} then 'sold_out'
    when ${t} >= ${batches.bookingCutoffAt} then 'booking_closed'
    else 'upcoming' end`;
}

async function toBatchDtos(
  db: Executor,
  rows: BatchRow[],
  now = new Date(),
): Promise<OrganizerBatch[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [titles, pickups, links] = await Promise.all([
    db
      .select({ id: organizerTreks.id, title: organizerTreks.title })
      .from(organizerTreks)
      .where(inArray(organizerTreks.id, [...new Set(rows.map((r) => r.organizerTrekId))])),
    db
      .select({
        batchId: batchPickups.batchId,
        pickupPointId: batchPickups.pickupPointId,
        name: pickupPoints.name,
        pickupAt: batchPickups.pickupAt,
      })
      .from(batchPickups)
      .innerJoin(pickupPoints, eq(pickupPoints.id, batchPickups.pickupPointId))
      .where(inArray(batchPickups.batchId, ids))
      .orderBy(asc(batchPickups.pickupAt)),
    db
      .select({ batchId: directLinks.batchId, token: directLinks.token })
      .from(directLinks)
      .where(and(inArray(directLinks.batchId, ids), eq(directLinks.active, true)))
      .orderBy(asc(directLinks.createdAt)),
  ]);
  const titleOf = new Map(titles.map((t) => [t.id, t.title]));
  // The batch's own booking link: the oldest active one.
  const linkOf = new Map<string, string>();
  for (const l of links) if (l.batchId && !linkOf.has(l.batchId)) linkOf.set(l.batchId, l.token);

  return rows.map((r) => ({
    id: r.id,
    organizerTrekId: r.organizerTrekId,
    name: r.name,
    trekTitle: titleOf.get(r.organizerTrekId) ?? '',
    departureAt: r.departureAt.toISOString(),
    returnAt: r.returnAt.toISOString(),
    bookingCutoffAt: r.bookingCutoffAt.toISOString(),
    pricePaise: r.pricePaise,
    capacity: r.capacity,
    confirmedSeats: r.confirmedSeats,
    seatsLeft: Math.max(0, r.capacity - r.confirmedSeats),
    maxSeatsPerBooking: r.maxSeatsPerBooking,
    status: r.status,
    view: deriveBatchView(r, now),
    notes: r.notes,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    cancelReason: r.cancelReason,
    bookingLinkToken: linkOf.get(r.id) ?? null,
    pickups: pickups
      .filter((p) => p.batchId === r.id)
      .map((p) => ({
        pickupPointId: p.pickupPointId,
        name: p.name,
        pickupAt: p.pickupAt.toISOString(),
      })),
    leads: r.leads,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

async function getBatchRow(db: Executor, organizerId: string, batchId: string, lock = false) {
  const query = db
    .select()
    .from(batches)
    .where(and(eq(batches.id, batchId), eq(batches.organizerId, organizerId)));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw notFound('Batch');
  return row;
}

export async function getBatch(db: Database, organizerId: string, batchId: string) {
  return (await toBatchDtos(db, [await getBatchRow(db, organizerId, batchId)]))[0]!;
}

/** Ordered by departure (soonest first), keyset-paginated on (departure_at, id). */
export async function listBatches(
  db: Database,
  organizerId: string,
  q: OrganizerBatchListQuery,
  /** Extra condition, e.g. a trek lead's own batches only. */
  scope?: SQL,
) {
  const now = new Date();
  const filters: SQL[] = [eq(batches.organizerId, organizerId)];
  if (scope) filters.push(scope);
  if (q.view) filters.push(sql`${batchViewSql(now)} = ${q.view}`);
  if (q.trekId) filters.push(eq(batches.organizerTrekId, q.trekId));
  if (q.from) filters.push(gte(batches.departureAt, new Date(q.from)));
  if (q.to) filters.push(lte(batches.departureAt, new Date(q.to)));
  if (q.cursor) {
    const [departureAt, id] = decodeCursor(q.cursor, 2);
    filters.push(
      sql`(${batches.departureAt}, ${batches.id}) > (${departureAt}::timestamptz, ${id}::uuid)`,
    );
  }
  const rows = await db
    .select()
    .from(batches)
    .where(and(...filters))
    .orderBy(asc(batches.departureAt), asc(batches.id))
    .limit(q.limit + 1);
  const page = toPage(rows, q.limit, (r) => [r.departureAt.toISOString(), r.id]);
  return { items: await toBatchDtos(db, page.items, now), nextCursor: page.nextCursor };
}

// ---------- Create ----------

export interface NewBatch {
  departureAt: Date;
  returnAt: Date;
  bookingCutoffAt: Date;
  pickups: { pickupPointId: string; pickupAt: Date }[];
}

export function validateTimes(
  b: { departureAt: Date; returnAt: Date; bookingCutoffAt: Date },
  now: Date,
  label = '',
) {
  const where = label ? ` (${label})` : '';
  if (b.departureAt <= now) throw badRequest(`Departure must be in the future${where}`);
  if (b.returnAt <= b.departureAt) throw badRequest(`Return must be after departure${where}`);
  if (b.bookingCutoffAt > b.departureAt)
    throw badRequest(`Booking cutoff must be on or before departure${where}`);
  if (b.bookingCutoffAt <= now) throw badRequest(`Booking cutoff must be in the future${where}`);
}

function rethrowPickupError(err: unknown): never {
  if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
    throw badRequest("Every pickup must be one of this trek's pickup points");
  }
  throw err;
}

// ---------- Names ----------

interface NamingContext {
  trekId: string;
  organizer: string;
  place: string;
}

/** Names use the destination ("Kudremukh"), falling back to the trek title. */
async function namingContext(
  tx: Tx,
  organizerId: string,
  trek: { id: string; title: string; catalogTrekId: string | null },
): Promise<NamingContext> {
  const [[org], [catalog]] = await Promise.all([
    tx.select({ name: organizers.name }).from(organizers).where(eq(organizers.id, organizerId)),
    trek.catalogTrekId
      ? tx
          .select({ name: catalogTreks.name })
          .from(catalogTreks)
          .where(eq(catalogTreks.id, trek.catalogTrekId))
      : Promise.resolve([]),
  ]);
  return {
    trekId: trek.id,
    organizer: org?.name ?? 'Organizer',
    place: catalog?.name ?? trek.title,
  };
}

/**
 * Inserts a batch named "<Org>_<Place>_<25th>_<Sept>_Batch_<n>", where n follows the trek's
 * other batches that day. A clash (concurrent create, or a number freed by a deleted draft)
 * moves on to the next number.
 */
async function insertNamed(
  tx: Tx,
  ctx: NamingContext,
  departureAt: Date,
  values: (name: string) => typeof batches.$inferInsert,
): Promise<BatchRow> {
  const istDay = (col: SQL | typeof batches.departureAt) =>
    sql`(${col} at time zone 'Asia/Kolkata')::date`;
  const [counted] = await tx
    .select({ sameDay: sql<number>`count(*)::int` })
    .from(batches)
    .where(
      and(
        eq(batches.organizerTrekId, ctx.trekId),
        sql`${istDay(batches.departureAt)} = ${istDay(sql`${departureAt.toISOString()}::timestamptz`)}`,
      ),
    );
  const first = (counted?.sameDay ?? 0) + 1;
  for (let n = first; ; n++) {
    const name = batchName({ organizer: ctx.organizer, place: ctx.place, departureAt, n });
    try {
      return await tx.transaction(async (sp) => {
        const [row] = await sp.insert(batches).values(values(name)).returning();
        return row!;
      });
    } catch (err) {
      if (pgConstraintName(err) !== 'batches_org_name_uq' || n >= first + 50) throw err;
    }
  }
}

export async function insertBatches(
  tx: Tx,
  organizerId: string,
  trekId: string,
  common: {
    pricePaise: number;
    capacity: number;
    maxSeatsPerBooking?: number | undefined;
    notes?: string | undefined;
    leads?: { name: string; phone: string }[] | undefined;
  },
  items: NewBatch[],
): Promise<BatchRow[]> {
  const trek = await getTrekRow(tx, organizerId, trekId);
  if (trek.status === 'archived') throw conflict('Cannot add batches to an archived trek');
  const naming = await namingContext(tx, organizerId, trek);

  const rows: BatchRow[] = [];
  for (const b of items) {
    rows.push(
      await insertNamed(tx, naming, b.departureAt, (name) => ({
        organizerTrekId: trekId,
        organizerId,
        name,
        departureAt: b.departureAt,
        returnAt: b.returnAt,
        bookingCutoffAt: b.bookingCutoffAt,
        pricePaise: common.pricePaise,
        capacity: common.capacity,
        maxSeatsPerBooking: Math.min(common.maxSeatsPerBooking ?? 10, common.capacity),
        notes: common.notes ?? null,
        leads: common.leads ?? [],
        status: 'draft' as const,
      })),
    );
  }

  // Every batch comes with its one booking link; it opens once the batch is published.
  if (rows.length) {
    await tx
      .insert(directLinks)
      .values(rows.map((row) => ({ organizerId, batchId: row.id, token: newDirectLinkToken() })));
  }

  const pickupRows = rows.flatMap((row, i) =>
    items[i]!.pickups.map((p) => ({ batchId: row.id, organizerTrekId: trekId, ...p })),
  );
  if (pickupRows.length) {
    try {
      await tx.insert(batchPickups).values(pickupRows);
    } catch (err) {
      rethrowPickupError(err);
    }
  }
  return rows;
}

export async function createBatch(
  db: Database,
  organizerId: string,
  trekId: string,
  input: CreateBatchRequest,
) {
  const now = new Date();
  const item: NewBatch = {
    departureAt: new Date(input.departureAt),
    returnAt: new Date(input.returnAt),
    bookingCutoffAt: new Date(input.bookingCutoffAt ?? input.departureAt),
    pickups: (input.pickups ?? []).map((p) => ({
      pickupPointId: p.pickupPointId,
      pickupAt: new Date(p.pickupAt),
    })),
  };
  validateTimes(item, now);
  const [row] = await db.transaction(async (tx) => {
    const rows = await insertBatches(tx, organizerId, trekId, input, [item]);
    await onLeadsSaved(
      tx,
      organizerId,
      (input.leads ?? []).map((l) => l.phone),
      { restore: true },
    );
    return rows;
  });
  return (await toBatchDtos(db, [row!]))[0]!;
}

/**
 * All-or-nothing: one invalid departure rejects the whole request. Pickups named for the first
 * time are added to the trek in the same transaction; `publish` makes every batch bookable.
 */
export async function bulkCreateBatches(
  db: Database,
  organizerId: string,
  trekId: string,
  input: BulkCreateBatchesRequest,
) {
  const now = new Date();
  const departures = input.departures.map((d, i) => {
    const item = {
      departureAt: new Date(d.departureAt),
      returnAt: new Date(d.returnAt),
      bookingCutoffAt: new Date(d.bookingCutoffAt ?? d.departureAt),
    };
    validateTimes(item, now, `departure #${i + 1}`);
    return item;
  });
  const starts = departures.map((d) => d.departureAt.getTime());
  if (new Set(starts).size !== starts.length) throw badRequest('Departures must not repeat');

  const rows = await db.transaction(async (tx) => {
    const pickups = await resolvePickups(tx, organizerId, trekId, input.pickups ?? []);
    const items: NewBatch[] = departures.map((d) => ({
      ...d,
      pickups: pickups.map((p) => ({
        pickupPointId: p.pickupPointId,
        pickupAt: new Date(d.departureAt.getTime() + p.minutesFromDeparture * 60_000),
      })),
    }));
    const created = await insertBatches(tx, organizerId, trekId, input, items);
    await onLeadsSaved(
      tx,
      organizerId,
      (input.leads ?? []).map((l) => l.phone),
      { restore: true },
    );
    if (input.publish) {
      for (const row of created) await publishBatchTx(tx, organizerId, row.id);
    }
    return created;
  });
  // Re-read: publishing changed status and published time.
  const fresh = await db
    .select()
    .from(batches)
    .where(
      inArray(
        batches.id,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(batches.departureAt));
  return toBatchDtos(db, fresh);
}

/** Pickups by id, or by name: an existing point of this trek with that name, else a new one. */
async function resolvePickups(
  tx: Tx,
  organizerId: string,
  trekId: string,
  input: NonNullable<BulkCreateBatchesRequest['pickups']>,
) {
  if (!input.some((p) => p.name)) {
    return input.map((p) => ({
      pickupPointId: p.pickupPointId!,
      minutesFromDeparture: p.minutesFromDeparture,
    }));
  }
  await getTrekRow(tx, organizerId, trekId);
  const existing = await tx
    .select({ id: pickupPoints.id, name: pickupPoints.name, sortOrder: pickupPoints.sortOrder })
    .from(pickupPoints)
    .where(eq(pickupPoints.organizerTrekId, trekId));
  const byName = new Map(existing.map((p) => [p.name.trim().toLowerCase(), p.id]));
  let nextSort = existing.reduce((m, p) => Math.max(m, p.sortOrder + 1), 0);

  const out: { pickupPointId: string; minutesFromDeparture: number }[] = [];
  for (const p of input) {
    if (p.pickupPointId) {
      out.push({ pickupPointId: p.pickupPointId, minutesFromDeparture: p.minutesFromDeparture });
      continue;
    }
    const key = p.name!.trim().toLowerCase();
    let id = byName.get(key);
    if (!id) {
      const [created] = await tx
        .insert(pickupPoints)
        .values({
          organizerTrekId: trekId,
          organizerId,
          name: p.name!.trim(),
          sortOrder: nextSort++,
        })
        .returning({ id: pickupPoints.id });
      id = created!.id;
      byName.set(key, id);
    }
    out.push({ pickupPointId: id, minutesFromDeparture: p.minutesFromDeparture });
  }
  if (new Set(out.map((p) => p.pickupPointId)).size !== out.length) {
    throw badRequest('Each pickup point can be listed once');
  }
  return out;
}

// ---------- Update ----------

/**
 * Edit rules: ended/cancelled batches are frozen; dates are frozen once seats are sold;
 * capacity can't drop below sold seats. Price changes apply to new bookings only.
 */
export async function updateBatch(
  db: Database,
  organizerId: string,
  batchId: string,
  input: UpdateBatchRequest,
) {
  const now = new Date();
  await db.transaction(async (tx) => {
    const current = await getBatchRow(tx, organizerId, batchId, true);
    const view = deriveBatchView(current, now);
    if (view === 'cancelled' || view === 'completed' || view === 'ongoing') {
      throw conflict(`A batch that is ${view} can't be edited`);
    }

    const changesDates =
      input.departureAt !== undefined ||
      input.returnAt !== undefined ||
      input.bookingCutoffAt !== undefined;
    const moves = input.departureAt !== undefined || input.returnAt !== undefined;
    if (moves && current.confirmedSeats > 0) {
      throw conflict('Dates cannot change after seats are booked; cancel the batch instead');
    }
    if (changesDates) {
      const next = {
        departureAt: input.departureAt ? new Date(input.departureAt) : current.departureAt,
        returnAt: input.returnAt ? new Date(input.returnAt) : current.returnAt,
        bookingCutoffAt: input.bookingCutoffAt
          ? new Date(input.bookingCutoffAt)
          : current.bookingCutoffAt,
      };
      validateTimes(next, now);
    }
    const capacity = input.capacity ?? current.capacity;
    if (capacity < current.confirmedSeats) {
      throw conflict(`Capacity can't go below the ${current.confirmedSeats} seats already booked`);
    }

    await tx
      .update(batches)
      .set({
        ...(input.pricePaise !== undefined ? { pricePaise: input.pricePaise } : {}),
        ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.leads !== undefined ? { leads: input.leads } : {}),
        ...(input.departureAt ? { departureAt: new Date(input.departureAt) } : {}),
        ...(input.returnAt ? { returnAt: new Date(input.returnAt) } : {}),
        ...(input.bookingCutoffAt ? { bookingCutoffAt: new Date(input.bookingCutoffAt) } : {}),
        maxSeatsPerBooking: Math.min(
          input.maxSeatsPerBooking ?? current.maxSeatsPerBooking,
          capacity,
        ),
      })
      .where(eq(batches.id, batchId));
    if (input.leads) {
      await onLeadsSaved(
        tx,
        organizerId,
        input.leads.map((l) => l.phone),
        { restore: true },
      );
    }
  });
  return getBatch(db, organizerId, batchId);
}

/** Replaces the batch's pickup set. Pickups already chosen by a booking can't be removed. */
export async function setBatchPickups(
  db: Database,
  organizerId: string,
  batchId: string,
  pickups: { pickupPointId: string; pickupAt: string }[],
) {
  const ids = pickups.map((p) => p.pickupPointId);
  if (new Set(ids).size !== ids.length) throw badRequest('Each pickup point can appear once');

  await db.transaction(async (tx) => {
    const batch = await getBatchRow(tx, organizerId, batchId, true);
    if (batch.status === 'cancelled' || batch.status === 'completed') {
      throw conflict(`A ${batch.status} batch can't be edited`);
    }
    try {
      await tx
        .delete(batchPickups)
        .where(
          and(
            eq(batchPickups.batchId, batchId),
            ids.length ? notInArray(batchPickups.pickupPointId, ids) : undefined,
          ),
        );
    } catch (err) {
      if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
        throw conflict('A pickup point that customers already chose cannot be removed');
      }
      throw err;
    }
    if (pickups.length === 0) return;
    try {
      await tx
        .insert(batchPickups)
        .values(
          pickups.map((p) => ({
            batchId,
            organizerTrekId: batch.organizerTrekId,
            pickupPointId: p.pickupPointId,
            pickupAt: new Date(p.pickupAt),
          })),
        )
        .onConflictDoUpdate({
          target: [batchPickups.batchId, batchPickups.pickupPointId],
          set: { pickupAt: sql`excluded.pickup_at` },
        });
    } catch (err) {
      rethrowPickupError(err);
    }
  });
  return getBatch(db, organizerId, batchId);
}

// ---------- Lifecycle ----------

export async function publishBatch(db: Database, organizerId: string, batchId: string) {
  await db.transaction((tx) => publishBatchTx(tx, organizerId, batchId));
  return getBatch(db, organizerId, batchId);
}

/** Publishes inside the caller's transaction (also used by one-step trek creation). */
export async function publishBatchTx(tx: Tx, organizerId: string, batchId: string) {
  {
    const batch = await getBatchRow(tx, organizerId, batchId, true);
    if (batch.status !== 'draft') throw conflict(`Batch is already ${batch.status}`);
    if (batch.bookingCutoffAt <= new Date()) {
      throw conflict('Booking cutoff has passed; update the dates before publishing');
    }
    // One click for organizers: publishing a departure also publishes its trek.
    const trek = await getTrekRow(tx, organizerId, batch.organizerTrekId);
    if (trek.status === 'archived') throw conflict('This trek is archived; restore it first');
    if (!trek.catalogTrekId) {
      throw conflict("Add the trek's destination (e.g. Kudremukh) before publishing");
    }
    const [destination] = await tx
      .select({ status: catalogTreks.status })
      .from(catalogTreks)
      .where(eq(catalogTreks.id, trek.catalogTrekId));
    if (destination?.status === 'archived') {
      throw conflict('This destination is no longer listed on Ohviana; choose another one');
    }
    // Otherwise customers couldn't see the departure (public pages need a published destination).
    if (destination?.status === 'draft') {
      await tx
        .update(catalogTreks)
        .set({ status: 'published' })
        .where(eq(catalogTreks.id, trek.catalogTrekId));
    }
    if (trek.status === 'draft') {
      await tx
        .update(organizerTreks)
        .set({ status: 'published' })
        .where(eq(organizerTreks.id, trek.id));
    }

    await tx
      .update(batches)
      .set({ status: 'published', publishedAt: new Date() })
      .where(eq(batches.id, batchId));
  }
}

/**
 * "Run this batch again": a new batch on new dates with the same price, seats, notes and
 * pickup points (pickup times keep their offset from departure). Gets its own generated name.
 */
export async function repeatBatch(
  db: Database,
  organizerId: string,
  batchId: string,
  input: RepeatBatchRequest,
) {
  const now = new Date();
  const departureAt = new Date(input.departureAt);
  const source = await getBatchRow(db, organizerId, batchId);
  const pickups = await db
    .select({ pickupPointId: batchPickups.pickupPointId, pickupAt: batchPickups.pickupAt })
    .from(batchPickups)
    .where(eq(batchPickups.batchId, batchId));
  const shift = (d: Date) =>
    new Date(departureAt.getTime() + (d.getTime() - source.departureAt.getTime()));
  const item: NewBatch = {
    departureAt,
    returnAt: new Date(input.returnAt),
    // By default keep the source's cutoff lead time (e.g. 12 hours before departure).
    bookingCutoffAt: input.bookingCutoffAt
      ? new Date(input.bookingCutoffAt)
      : shift(source.bookingCutoffAt),
    pickups: pickups.map((p) => ({ pickupPointId: p.pickupPointId, pickupAt: shift(p.pickupAt) })),
  };
  validateTimes(item, now);
  const id = await db.transaction(async (tx) => {
    const [created] = await insertBatches(
      tx,
      organizerId,
      source.organizerTrekId,
      {
        pricePaise: source.pricePaise,
        capacity: source.capacity,
        maxSeatsPerBooking: source.maxSeatsPerBooking,
        notes: source.notes ?? undefined,
        leads: source.leads,
      },
      [item],
    );
    await onLeadsSaved(
      tx,
      organizerId,
      source.leads.map((l) => l.phone),
      { restore: false },
    );
    if (input.publish) await publishBatchTx(tx, organizerId, created!.id);
    return created!.id;
  });
  return getBatch(db, organizerId, id);
}

/**
 * Cancels a published batch and every confirmed booking on it, atomically. Customers are
 * notified through the outbox (refunds are outside the payment-less MVP).
 */
export async function cancelBatch(
  db: Database,
  organizerId: string,
  userId: string,
  batchId: string,
  reason: string,
) {
  await db.transaction(async (tx) => {
    const batch = await getBatchRow(tx, organizerId, batchId, true);
    if (batch.status === 'draft') throw conflict('Delete a draft batch instead of cancelling it');
    if (batch.status !== 'published') throw conflict(`Batch is already ${batch.status}`);
    if (batch.returnAt <= new Date()) throw conflict('This batch has already ended');

    const now = new Date();
    const cancelled = await tx
      .update(bookings)
      .set({
        status: 'cancelled',
        cancelledAt: now,
        cancelledBy: userId,
        cancelReason: `Batch cancelled: ${reason}`,
      })
      .where(and(eq(bookings.batchId, batchId), eq(bookings.status, 'confirmed')))
      .returning({ id: bookings.id, bookingReference: bookings.bookingReference });

    await tx
      .update(batches)
      .set({ status: 'cancelled', cancelledAt: now, cancelReason: reason, confirmedSeats: 0 })
      .where(eq(batches.id, batchId));

    if (cancelled.length) {
      await tx.insert(bookingEvents).values(
        cancelled.map((b) => ({
          bookingId: b.id,
          eventType: 'cancelled_by_organizer',
          actorId: userId,
          payload: { reason, batchId },
        })),
      );
    }
    await enqueueEvent(tx, 'batch.cancelled', {
      organizerId,
      batchId,
      reason,
      bookingIds: cancelled.map((b) => b.id),
    });
  });
  return getBatch(db, organizerId, batchId);
}

export async function deleteDraftBatch(db: Database, organizerId: string, batchId: string) {
  const deleted = await db
    .delete(batches)
    .where(
      and(
        eq(batches.id, batchId),
        eq(batches.organizerId, organizerId),
        eq(batches.status, 'draft'),
      ),
    )
    .returning({ id: batches.id });
  if (deleted.length === 0) {
    await getBatchRow(db, organizerId, batchId); // 404 if it doesn't exist
    throw conflict('Only draft batches can be deleted; cancel published batches instead');
  }
}

// ---------- Dashboard ----------

export async function dashboardSummary(
  db: Database,
  organizerId: string,
): Promise<DashboardSummary> {
  const view = batchViewSql(new Date());
  const [counts, bySource] = await Promise.all([
    db
      .select({ view, n: sql<number>`count(*)::int` })
      .from(batches)
      .where(eq(batches.organizerId, organizerId))
      // Positional: a parameterized CASE in SELECT and GROUP BY wouldn't match textually.
      .groupBy(sql`1`),
    db
      .select({
        source: bookings.source,
        confirmed: sql<number>`count(*)::int`,
        seatsSold: sql<number>`coalesce(sum(${bookings.quantity}), 0)::int`,
        grossPaise: sql<string>`coalesce(sum(${bookings.totalPaise}), 0)::bigint`,
        commissionPaise: sql<string>`coalesce(sum(${bookings.commissionPaise}), 0)::bigint`,
      })
      .from(bookings)
      .where(and(eq(bookings.organizerId, organizerId), eq(bookings.status, 'confirmed')))
      .groupBy(bookings.source),
  ]);

  const batchCounts = Object.fromEntries(BATCH_VIEWS.map((v) => [v, 0])) as Record<
    BatchView,
    number
  >;
  for (const c of counts) batchCounts[c.view] = c.n;

  const totalsOf = (source?: (typeof bySource)[number]['source']) =>
    bySource
      .filter((r) => !source || r.source === source)
      .reduce(
        (t, r) => ({
          confirmed: t.confirmed + r.confirmed,
          seatsSold: t.seatsSold + r.seatsSold,
          grossPaise: t.grossPaise + Number(r.grossPaise),
          commissionPaise: t.commissionPaise + Number(r.commissionPaise),
        }),
        { confirmed: 0, seatsSold: 0, grossPaise: 0, commissionPaise: 0 },
      );
  return {
    batches: batchCounts,
    bookings: {
      ...totalsOf(),
      channels: {
        marketplace: totalsOf('MARKETPLACE'),
        directLink: totalsOf('ORGANIZER_DIRECT'),
        addedByYou: totalsOf('ORGANIZER_OFFLINE'),
      },
    },
  };
}
