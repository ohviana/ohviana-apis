import { asc, eq, gt, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import {
  batchPickups,
  batches,
  catalogTreks,
  organizers,
  organizerTreks,
  pickupPoints,
  type Database,
} from '@ohviana/db';
import type { PublicBatch } from '@ohviana/contracts';
import type { DIFFICULTIES } from '@ohviana/shared';
import { badRequest } from '../../lib/errors';
import { loadTrekPhotos } from '../media/service';

const DAY = 86_400_000;
const MAX_WINDOW_DAYS = 366;
/** Customers think in Indian calendar days; all date filters are interpreted in IST. */
const IST_OFFSET = '+05:30';

export interface Window {
  start: Date;
  /** Exclusive. */
  end: Date | null;
}

/**
 * Turns optional IST calendar days into an instant range. `to` includes its whole day; the
 * start is never earlier than now, so past departures never appear.
 */
export function istWindow(
  from: string | undefined,
  to: string | undefined,
  now = new Date(),
): Window {
  const requestedStart = from ? new Date(`${from}T00:00:00${IST_OFFSET}`) : now;
  const start = requestedStart < now ? now : requestedStart;
  const end = to ? new Date(new Date(`${to}T00:00:00${IST_OFFSET}`).getTime() + DAY) : null;
  if (from && to && end! <= requestedStart)
    throw badRequest('The end date must be on or after the start date');
  if (end && end.getTime() - requestedStart.getTime() > MAX_WINDOW_DAYS * DAY) {
    throw badRequest(`Choose dates at most ${MAX_WINDOW_DAYS} days apart`);
  }
  return { start, end };
}

/**
 * THE public visibility rule. A batch is visible only if the batch is published and departs in
 * the window, its organizer is approved, and its template and catalog trek are published.
 * `bookableOnly` additionally requires free seats and an open booking cutoff.
 */
export function visibleBatchConditions(
  window: Window,
  bookableOnly: boolean,
  now = new Date(),
): SQL[] {
  const conditions: SQL[] = [
    eq(batches.status, 'published'),
    eq(organizers.status, 'approved'),
    eq(organizerTreks.status, 'published'),
    eq(catalogTreks.status, 'published'),
    gte(batches.departureAt, window.start),
  ];
  if (window.end) conditions.push(lt(batches.departureAt, window.end));
  if (bookableOnly) {
    conditions.push(lt(batches.confirmedSeats, batches.capacity), gt(batches.bookingCutoffAt, now));
  }
  return conditions;
}

/** batches ⋈ template ⋈ organizer ⋈ catalog trek: the joins every visibility check needs. */
export function visibleBatchesQuery(db: Database) {
  return db
    .select({
      id: batches.id,
      departureAt: batches.departureAt,
      returnAt: batches.returnAt,
      bookingCutoffAt: batches.bookingCutoffAt,
      pricePaise: batches.pricePaise,
      capacity: batches.capacity,
      confirmedSeats: batches.confirmedSeats,
      maxSeatsPerBooking: batches.maxSeatsPerBooking,
      organizer: {
        id: organizers.id,
        name: organizers.name,
        slug: organizers.slug,
        city: organizers.city,
        logoUrl: organizers.logoUrl,
      },
      trek: {
        id: organizerTreks.id,
        title: organizerTreks.title,
        slug: organizerTreks.slug,
        summary: organizerTreks.summary,
        durationDays: organizerTreks.durationDays,
        startPoint: organizerTreks.startPoint,
        // The organizer's own rating, else the destination's.
        difficulty: sql<
          (typeof DIFFICULTIES)[number] | null
        >`coalesce(${organizerTreks.difficulty}, ${catalogTreks.difficulty})`,
        itinerary: organizerTreks.itinerary,
        inclusions: organizerTreks.inclusions,
        exclusions: organizerTreks.exclusions,
        thingsToCarry: organizerTreks.thingsToCarry,
        cancellationPolicy: organizerTreks.cancellationPolicy,
      },
      catalogTrek: { id: catalogTreks.id, name: catalogTreks.name, slug: catalogTreks.slug },
    })
    .from(batches)
    .innerJoin(organizerTreks, eq(organizerTreks.id, batches.organizerTrekId))
    .innerJoin(organizers, eq(organizers.id, batches.organizerId))
    .innerJoin(catalogTreks, eq(catalogTreks.id, organizerTreks.catalogTrekId));
}

type VisibleRow = Awaited<ReturnType<ReturnType<typeof visibleBatchesQuery>['where']>>[number];

export async function toPublicBatches(
  db: Database,
  rows: VisibleRow[],
  now = new Date(),
): Promise<PublicBatch[]> {
  if (rows.length === 0) return [];
  const photos = await loadTrekPhotos(db, [...new Set(rows.map((r) => r.trek.id))]);
  const pickups = await db
    .select({
      batchId: batchPickups.batchId,
      pickupPointId: pickupPoints.id,
      name: pickupPoints.name,
      address: pickupPoints.address,
      landmark: pickupPoints.landmark,
      mapsUrl: pickupPoints.mapsUrl,
      pickupAt: batchPickups.pickupAt,
    })
    .from(batchPickups)
    .innerJoin(pickupPoints, eq(pickupPoints.id, batchPickups.pickupPointId))
    .where(
      inArray(
        batchPickups.batchId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(batchPickups.pickupAt));

  return rows.map((r) => {
    const seatsLeft = Math.max(0, r.capacity - r.confirmedSeats);
    return {
      id: r.id,
      departureAt: r.departureAt.toISOString(),
      returnAt: r.returnAt.toISOString(),
      bookingCutoffAt: r.bookingCutoffAt.toISOString(),
      pricePaise: r.pricePaise,
      capacity: r.capacity,
      seatsLeft,
      maxSeatsPerBooking: Math.min(r.maxSeatsPerBooking, seatsLeft),
      availability:
        seatsLeft === 0 ? 'sold_out' : r.bookingCutoffAt <= now ? 'booking_closed' : 'available',
      organizer: r.organizer,
      trek: { ...r.trek, photos: photos.get(r.trek.id) ?? [] },
      catalogTrek: r.catalogTrek,
      pickups: pickups
        .filter((p) => p.batchId === r.id)
        .map(({ batchId: _b, pickupAt, ...p }) => ({ ...p, pickupAt: pickupAt.toISOString() })),
    };
  });
}

/** Keyset ordering for batch lists. */
export function batchOrder(sort: 'departure_asc' | 'price_asc') {
  return sort === 'price_asc'
    ? [asc(batches.pricePaise), asc(batches.departureAt), asc(batches.id)]
    : [asc(batches.departureAt), asc(batches.id)];
}

export function batchCursorCondition(sort: 'departure_asc' | 'price_asc', parts: string[]): SQL {
  return sort === 'price_asc'
    ? sql`(${batches.pricePaise}, ${batches.departureAt}, ${batches.id}) > (${parts[0]}::bigint, ${parts[1]}::timestamptz, ${parts[2]}::uuid)`
    : sql`(${batches.departureAt}, ${batches.id}) > (${parts[0]}::timestamptz, ${parts[1]}::uuid)`;
}

export function batchCursorParts(sort: 'departure_asc' | 'price_asc', r: VisibleRow): string[] {
  return sort === 'price_asc'
    ? [String(r.pricePaise), r.departureAt.toISOString(), r.id]
    : [r.departureAt.toISOString(), r.id];
}
