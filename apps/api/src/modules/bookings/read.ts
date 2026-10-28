import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  batchPickups,
  batches,
  bookingGuests,
  bookings,
  catalogTreks,
  organizers,
  organizerTreks,
  pickupPoints,
  type Database,
  type Tx,
} from '@ohviana/db';
import type { CustomerBooking, OrganizerBooking } from '@ohviana/contracts';

type Executor = Database | Tx;

function bookingQuery(db: Executor) {
  return db
    .select({
      booking: bookings,
      batch: {
        id: batches.id,
        departureAt: batches.departureAt,
        returnAt: batches.returnAt,
      },
      catalogTrekName: catalogTreks.name,
      organizer: { id: organizers.id, name: organizers.name, slug: organizers.slug },
      pickupName: pickupPoints.name,
      pickupAt: batchPickups.pickupAt,
    })
    .from(bookings)
    .innerJoin(batches, eq(batches.id, bookings.batchId))
    .innerJoin(organizerTreks, eq(organizerTreks.id, batches.organizerTrekId))
    .innerJoin(catalogTreks, eq(catalogTreks.id, organizerTreks.catalogTrekId))
    .innerJoin(organizers, eq(organizers.id, bookings.organizerId))
    .leftJoin(
      batchPickups,
      and(
        eq(batchPickups.batchId, bookings.batchId),
        eq(batchPickups.pickupPointId, bookings.pickupPointId),
      ),
    )
    .leftJoin(pickupPoints, eq(pickupPoints.id, bookings.pickupPointId));
}

type Row = Awaited<ReturnType<ReturnType<typeof bookingQuery>['where']>>[number];

/** Travellers with their own boarding point (falling back to the booking's), in booking order. */
async function guestsFor(db: Executor, bookingIds: string[]) {
  if (bookingIds.length === 0) return new Map<string, CustomerBooking['guests']>();
  const pickupId = sql`coalesce(${bookingGuests.pickupPointId}, ${bookings.pickupPointId})`;
  const rows = await db
    .select({
      bookingId: bookingGuests.bookingId,
      fullName: bookingGuests.fullName,
      phone: bookingGuests.phone,
      age: bookingGuests.age,
      gender: bookingGuests.gender,
      pickupName: pickupPoints.name,
      pickupAt: batchPickups.pickupAt,
    })
    .from(bookingGuests)
    .innerJoin(bookings, eq(bookings.id, bookingGuests.bookingId))
    .leftJoin(
      batchPickups,
      and(
        eq(batchPickups.batchId, bookings.batchId),
        sql`${batchPickups.pickupPointId} = ${pickupId}`,
      ),
    )
    .leftJoin(pickupPoints, sql`${pickupPoints.id} = ${pickupId}`)
    .where(inArray(bookingGuests.bookingId, bookingIds))
    .orderBy(asc(bookingGuests.position), asc(bookingGuests.fullName));
  const map = new Map<string, CustomerBooking['guests']>();
  for (const g of rows) {
    const list = map.get(g.bookingId) ?? [];
    list.push({
      fullName: g.fullName,
      phone: g.phone,
      age: g.age,
      gender: g.gender,
      pickup:
        g.pickupName && g.pickupAt
          ? { name: g.pickupName, pickupAt: g.pickupAt.toISOString() }
          : null,
    });
    map.set(g.bookingId, list);
  }
  return map;
}

function toCustomer(r: Row, guests: CustomerBooking['guests']): CustomerBooking {
  const b = r.booking;
  return {
    bookingReference: b.bookingReference,
    status: b.status,
    source: b.source,
    quantity: b.quantity,
    unitPricePaise: b.unitPricePaise,
    totalPaise: b.totalPaise,
    batch: {
      id: r.batch.id,
      departureAt: r.batch.departureAt.toISOString(),
      returnAt: r.batch.returnAt.toISOString(),
      // What the customer agreed to, even if the template is renamed later.
      trekTitle: b.policySnapshot.trekTitle,
      catalogTrekName: r.catalogTrekName,
      organizer: r.organizer,
    },
    pickup:
      r.pickupName && r.pickupAt
        ? { name: r.pickupName, pickupAt: r.pickupAt.toISOString() }
        : null,
    contact: { name: b.contactName, phone: b.contactPhone, email: b.contactEmail },
    guests,
    cancellationPolicy: b.policySnapshot.cancellationPolicy,
    cancelledAt: b.cancelledAt?.toISOString() ?? null,
    cancelReason: b.cancelReason,
    createdAt: b.createdAt.toISOString(),
  };
}

/** Newest first (ties broken by id), optionally limited for keyset pagination. */
export async function loadCustomerBookings(db: Executor, where: SQL, limit?: number) {
  const query = bookingQuery(db).where(where).orderBy(desc(bookings.createdAt), desc(bookings.id));
  const rows = limit ? await query.limit(limit) : await query;
  const guests = await guestsFor(
    db,
    rows.map((r) => r.booking.id),
  );
  return rows.map((r) => ({ row: r.booking, dto: toCustomer(r, guests.get(r.booking.id) ?? []) }));
}

export async function loadOrganizerBookings(db: Executor, where: SQL): Promise<OrganizerBooking[]> {
  const rows = await bookingQuery(db).where(where).orderBy(asc(bookings.createdAt));
  const guests = await guestsFor(
    db,
    rows.map((r) => r.booking.id),
  );
  return rows.map((r) => {
    const b = r.booking;
    return {
      ...toCustomer(r, guests.get(b.id) ?? []),
      commissionRateBps: b.commissionRateBps,
      commissionPaise: b.commissionPaise,
      emergencyContact:
        b.emergencyContactName && b.emergencyContactPhone
          ? { name: b.emergencyContactName, phone: b.emergencyContactPhone }
          : null,
    };
  });
}
