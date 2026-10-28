import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import {
  batchPickups,
  batches,
  bookingEvents,
  bookingGuests,
  bookings,
  catalogTreks,
  directLinks,
  idempotencyKeys,
  organizers,
  organizerTreks,
  pgConstraintName,
  type Database,
  type Tx,
} from '@ohviana/db';
import type {
  AddBatchMembersRequest,
  CreateBookingRequest,
  CreateBookingResponse,
  CustomerBooking,
} from '@ohviana/contracts';
import { commissionPaise, type BookingSource } from '@ohviana/shared';
import { enqueueEvent } from '../../lib/audit';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { loadCustomerBookings } from './read';

const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
/** No 0/O, 1/I/L: references get read out over the phone. */
const REFERENCE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newBookingReference(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return `OHV-${s}`;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function tokenMatches(token: string, hash: string | null): boolean {
  if (!hash) return false;
  const a = Buffer.from(sha256(token), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

async function issueAccessToken(tx: Tx, bookingId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await tx
    .update(bookings)
    .set({ accessTokenHash: sha256(token) })
    .where(eq(bookings.id, bookingId));
  return token;
}

type GuestInput = CreateBookingRequest['guests'][number];

/**
 * One row per traveller, each with their own boarding point (defaulting to the booking's) and
 * phone (the traveller who is the booking contact is reached on the contact's number).
 */
function guestRows(
  bookingId: string,
  guests: GuestInput[],
  opts: {
    pickupPointId: string | null;
    offered: string[];
    contact: { name: string; phone: string };
  },
) {
  const isContact = (name: string) =>
    name.trim().toLowerCase() === opts.contact.name.trim().toLowerCase();
  return guests.map((g, position) => {
    if (g.pickupPointId && !opts.offered.includes(g.pickupPointId)) {
      throw badRequest(`${g.fullName}'s pickup point is not offered for this departure`);
    }
    return {
      bookingId,
      position,
      fullName: g.fullName,
      phone: g.phone ?? (isContact(g.fullName) ? opts.contact.phone : null),
      age: g.age ?? null,
      gender: g.gender ?? null,
      pickupPointId: g.pickupPointId ?? opts.pickupPointId,
    };
  });
}

export interface CreateBookingInput {
  userId: string | null;
  idempotencyKey: string;
  body: CreateBookingRequest;
}

export interface CreateBookingResult {
  status: 201;
  body: CreateBookingResponse;
  replayed: boolean;
}

/**
 * Reserves seats and confirms the booking in one transaction:
 *   idempotency claim → lock batch row → validate → price/attribute → insert → bump seats.
 *
 * Concurrency: the batch row is locked FOR UPDATE, so seat checks and the seat increment are
 * serialized per batch and the last seat can never be sold twice. A duplicate request with the
 * same Idempotency-Key blocks on the key's primary key until the first commits, then replays
 * its result; if the first failed, its claim rolled back and the retry runs fresh.
 */
export async function createBooking(
  db: Database,
  input: CreateBookingInput,
): Promise<CreateBookingResult> {
  const scope = input.userId ? `user:${input.userId}` : 'anon';
  const requestHash = sha256(JSON.stringify(input.body));

  return db.transaction(async (tx) => {
    // ---- 1. Idempotency claim ----
    const keyWhere = and(
      eq(idempotencyKeys.scope, scope),
      eq(idempotencyKeys.key, input.idempotencyKey),
    );
    const claim = () =>
      tx
        .insert(idempotencyKeys)
        .values({
          scope,
          key: input.idempotencyKey,
          requestHash,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
        })
        .onConflictDoNothing()
        .returning({ key: idempotencyKeys.key });

    let claimed = await claim();
    if (claimed.length === 0) {
      // An expired key is free to reuse.
      const expired = await tx
        .delete(idempotencyKeys)
        .where(and(keyWhere, sql`${idempotencyKeys.expiresAt} <= now()`))
        .returning({ key: idempotencyKeys.key });
      if (expired.length > 0) claimed = await claim();
    }

    if (claimed.length === 0) {
      const [existing] = await tx.select().from(idempotencyKeys).where(keyWhere);
      if (existing && existing.requestHash !== requestHash) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'This Idempotency-Key was already used for a different request',
        );
      }
      if (existing?.responseBody) {
        const stored = existing.responseBody as CustomerBooking;
        // The secret isn't stored in plain text; a replay gets a fresh one.
        const [row] = await tx
          .select({ id: bookings.id })
          .from(bookings)
          .where(eq(bookings.bookingReference, stored.bookingReference));
        const accessToken = await issueAccessToken(tx, row!.id);
        return { status: 201, body: { ...stored, accessToken }, replayed: true };
      }
      throw conflict('A request with this Idempotency-Key is still being processed; retry shortly');
    }

    // ---- 2. Lock the batch and load everything needed to validate and price ----
    const now = new Date();
    const [ctx] = await tx
      .select({
        batch: batches,
        organizerStatus: organizers.status,
        organizerName: organizers.name,
        commissionRateBps: organizers.commissionRateBps,
        trek: {
          title: organizerTreks.title,
          status: organizerTreks.status,
          inclusions: organizerTreks.inclusions,
          exclusions: organizerTreks.exclusions,
          cancellationPolicy: organizerTreks.cancellationPolicy,
        },
        catalogStatus: catalogTreks.status,
      })
      .from(batches)
      .innerJoin(organizers, eq(organizers.id, batches.organizerId))
      .innerJoin(organizerTreks, eq(organizerTreks.id, batches.organizerTrekId))
      .innerJoin(catalogTreks, eq(catalogTreks.id, organizerTreks.catalogTrekId))
      .where(eq(batches.id, input.body.batchId))
      .for('update', { of: batches });

    const bookable =
      ctx &&
      ctx.batch.status === 'published' &&
      ctx.organizerStatus === 'approved' &&
      ctx.trek.status === 'published' &&
      ctx.catalogStatus === 'published' &&
      ctx.batch.departureAt > now;
    if (!bookable) throw notFound('Departure');
    const batch = ctx.batch;

    // ---- 3. Validate the request against the locked batch ----
    if (batch.bookingCutoffAt <= now) {
      throw new AppError('BOOKING_CUTOFF', 'Bookings for this departure have closed');
    }
    const { quantity } = input.body;
    if (quantity > batch.maxSeatsPerBooking) {
      throw badRequest(`At most ${batch.maxSeatsPerBooking} seats per booking`);
    }
    const seatsLeft = batch.capacity - batch.confirmedSeats;
    if (quantity > seatsLeft) {
      throw new AppError(
        'SOLD_OUT',
        seatsLeft === 0 ? 'This departure is sold out' : `Only ${seatsLeft} seat(s) left`,
        { seatsLeft },
      );
    }

    const pickups = await tx
      .select({ pickupPointId: batchPickups.pickupPointId })
      .from(batchPickups)
      .where(eq(batchPickups.batchId, batch.id));
    const pickupPointId = input.body.pickupPointId ?? null;
    if (pickups.length > 0 && !pickupPointId) throw badRequest('Choose a pickup point');
    if (pickupPointId && !pickups.some((p) => p.pickupPointId === pickupPointId)) {
      throw badRequest('That pickup point is not offered for this departure');
    }

    // ---- 4. Attribution: decided here, never trusted from the client ----
    let source: BookingSource = 'MARKETPLACE';
    let directLinkId: string | null = null;
    if (input.body.entryToken) {
      const [link] = await tx
        .select({
          id: directLinks.id,
          organizerId: directLinks.organizerId,
          batchId: directLinks.batchId,
        })
        .from(directLinks)
        .where(
          and(
            eq(directLinks.token, input.body.entryToken),
            eq(directLinks.active, true),
            or(isNull(directLinks.expiresAt), gt(directLinks.expiresAt, now)),
          ),
        );
      const applies =
        link &&
        link.organizerId === batch.organizerId &&
        (!link.batchId || link.batchId === batch.id);
      if (!applies) throw badRequest("This booking link isn't valid for this departure");
      source = 'ORGANIZER_DIRECT';
      directLinkId = link.id;
    }

    // ---- 5. Price and commission (server-side, snapshotted) ----
    const unitPricePaise = batch.pricePaise;
    const totalPaise = unitPricePaise * quantity;
    const rateBps = source === 'ORGANIZER_DIRECT' ? 0 : ctx.commissionRateBps;

    // ---- 6. Write booking, guests, seats, audit, notification ----
    let created: typeof bookings.$inferSelect | undefined;
    for (let attempt = 0; !created; attempt++) {
      try {
        created = await tx.transaction(async (sp) => {
          const [row] = await sp
            .insert(bookings)
            .values({
              bookingReference: newBookingReference(),
              batchId: batch.id,
              organizerId: batch.organizerId,
              userId: input.userId,
              source,
              directLinkId,
              status: 'confirmed',
              quantity,
              unitPricePaise,
              totalPaise,
              commissionRateBps: rateBps,
              commissionPaise: commissionPaise(totalPaise, rateBps),
              commissionSnapshot: {
                basis:
                  source === 'ORGANIZER_DIRECT'
                    ? 'ORGANIZER_DIRECT_ZERO'
                    : 'MARKETPLACE_AGREED_RATE',
                rateBps,
                computedOnPaise: totalPaise,
              },
              policySnapshot: {
                trekTitle: ctx.trek.title,
                organizerName: ctx.organizerName,
                departureAt: batch.departureAt.toISOString(),
                returnAt: batch.returnAt.toISOString(),
                cancellationPolicy: ctx.trek.cancellationPolicy,
                inclusions: ctx.trek.inclusions,
                exclusions: ctx.trek.exclusions,
              },
              pickupPointId,
              contactName: input.body.contact.name,
              contactPhone: input.body.contact.phone,
              contactEmail: input.body.contact.email ?? null,
              emergencyContactName: input.body.emergencyContact?.name ?? null,
              emergencyContactPhone: input.body.emergencyContact?.phone ?? null,
            })
            .returning();
          return row!;
        });
      } catch (err) {
        // A reference collision is astronomically unlikely; retry a couple of times anyway.
        if (pgConstraintName(err) !== 'bookings_reference_uq' || attempt >= 2) throw err;
      }
    }

    await tx.insert(bookingGuests).values(
      guestRows(created.id, input.body.guests, {
        pickupPointId,
        offered: pickups.map((p) => p.pickupPointId),
        contact: input.body.contact,
      }),
    );
    await tx
      .update(batches)
      .set({ confirmedSeats: sql`${batches.confirmedSeats} + ${quantity}` })
      .where(eq(batches.id, batch.id));
    await tx.insert(bookingEvents).values({
      bookingId: created.id,
      eventType: 'confirmed',
      actorId: input.userId,
      payload: { source, quantity, totalPaise },
    });
    await enqueueEvent(tx, 'booking.confirmed', {
      organizerId: batch.organizerId,
      bookingId: created.id,
      bookingReference: created.bookingReference,
    });

    const accessToken = await issueAccessToken(tx, created.id);
    const [loaded] = await loadCustomerBookings(tx, eq(bookings.id, created.id));
    await tx
      .update(idempotencyKeys)
      .set({ responseStatus: 201, responseBody: loaded!.dto })
      .where(keyWhere);

    return { status: 201, body: { ...loaded!.dto, accessToken }, replayed: false };
  });
}

// ---------- Organizer-added members ----------

export interface AddMembersInput {
  organizerId: string;
  actorId: string;
  batchId: string;
  body: AddBatchMembersRequest;
}

/**
 * The organizer records people who booked outside Ohviana (phone, WhatsApp, walk-in). Same seat
 * accounting as online bookings (batch row locked, capacity enforced), but: works on draft
 * batches too, ignores the booking cutoff and per-booking seat limit, and carries no commission.
 * Returns the new booking's reference.
 */
export async function addBatchMembers(db: Database, input: AddMembersInput): Promise<string> {
  const { body } = input;
  const quantity = body.guests.length;
  return db.transaction(async (tx) => {
    const now = new Date();
    const [ctx] = await tx
      .select({
        batch: batches,
        organizerName: organizers.name,
        trek: {
          title: organizerTreks.title,
          inclusions: organizerTreks.inclusions,
          exclusions: organizerTreks.exclusions,
          cancellationPolicy: organizerTreks.cancellationPolicy,
        },
      })
      .from(batches)
      .innerJoin(organizers, eq(organizers.id, batches.organizerId))
      .innerJoin(organizerTreks, eq(organizerTreks.id, batches.organizerTrekId))
      .where(and(eq(batches.id, input.batchId), eq(batches.organizerId, input.organizerId)))
      .for('update', { of: batches });
    if (!ctx) throw notFound('Batch');
    const batch = ctx.batch;
    if (batch.status === 'cancelled' || batch.status === 'completed') {
      throw conflict(`This batch is ${batch.status}`);
    }
    if (batch.returnAt <= now) throw conflict('This batch has already ended');

    const seatsLeft = batch.capacity - batch.confirmedSeats;
    if (quantity > seatsLeft) {
      throw new AppError(
        'SOLD_OUT',
        seatsLeft === 0
          ? 'This batch is full; increase its seats first'
          : `Only ${seatsLeft} seat(s) left; increase the batch's seats to add more`,
        { seatsLeft },
      );
    }
    const offered = (
      await tx
        .select({ id: batchPickups.pickupPointId })
        .from(batchPickups)
        .where(eq(batchPickups.batchId, batch.id))
    ).map((p) => p.id);
    // The booking's pickup: the one given, else the first traveller's.
    const pickupPointId =
      body.pickupPointId ?? body.guests.find((g) => g.pickupPointId)?.pickupPointId ?? null;
    if (pickupPointId && !offered.includes(pickupPointId)) {
      throw badRequest('That pickup point is not offered for this batch');
    }

    const unitPricePaise = body.unitPricePaise ?? batch.pricePaise;
    const totalPaise = unitPricePaise * quantity;
    let created: typeof bookings.$inferSelect | undefined;
    for (let attempt = 0; !created; attempt++) {
      try {
        created = await tx.transaction(async (sp) => {
          const [row] = await sp
            .insert(bookings)
            .values({
              bookingReference: newBookingReference(),
              batchId: batch.id,
              organizerId: batch.organizerId,
              userId: null,
              source: 'ORGANIZER_OFFLINE',
              directLinkId: null,
              status: 'confirmed',
              quantity,
              unitPricePaise,
              totalPaise,
              commissionRateBps: 0,
              commissionPaise: 0,
              commissionSnapshot: {
                basis: 'ORGANIZER_OFFLINE_ZERO',
                rateBps: 0,
                computedOnPaise: totalPaise,
              },
              policySnapshot: {
                trekTitle: ctx.trek.title,
                organizerName: ctx.organizerName,
                departureAt: batch.departureAt.toISOString(),
                returnAt: batch.returnAt.toISOString(),
                cancellationPolicy: ctx.trek.cancellationPolicy,
                inclusions: ctx.trek.inclusions,
                exclusions: ctx.trek.exclusions,
              },
              pickupPointId,
              contactName: body.contact.name,
              contactPhone: body.contact.phone,
              contactEmail: body.contact.email ?? null,
            })
            .returning();
          return row!;
        });
      } catch (err) {
        if (pgConstraintName(err) !== 'bookings_reference_uq' || attempt >= 2) throw err;
      }
    }

    await tx
      .insert(bookingGuests)
      .values(
        guestRows(created!.id, body.guests, { pickupPointId, offered, contact: body.contact }),
      );
    await tx
      .update(batches)
      .set({ confirmedSeats: sql`${batches.confirmedSeats} + ${quantity}` })
      .where(eq(batches.id, batch.id));
    await tx.insert(bookingEvents).values({
      bookingId: created.id,
      eventType: 'added_by_organizer',
      actorId: input.actorId,
      payload: { quantity, totalPaise },
    });
    return created.bookingReference;
  });
}

// ---------- Cancellation ----------

export interface CancelInput {
  bookingId: string;
  actorId: string | null;
  by: 'customer' | 'organizer';
  reason: string | null;
}

/**
 * Cancels a confirmed booking before departure and releases its seats. Locks the batch first,
 * then the booking: the same order as booking creation and batch cancellation, so these never
 * deadlock each other.
 */
export async function cancelBooking(db: Database, input: CancelInput): Promise<void> {
  await db.transaction(async (tx) => {
    const [ref] = await tx
      .select({ batchId: bookings.batchId })
      .from(bookings)
      .where(eq(bookings.id, input.bookingId));
    if (!ref) throw notFound('Booking');

    const [batch] = await tx
      .select({ departureAt: batches.departureAt })
      .from(batches)
      .where(eq(batches.id, ref.batchId))
      .for('update');
    const [booking] = await tx
      .select()
      .from(bookings)
      .where(eq(bookings.id, input.bookingId))
      .for('update');

    if (booking!.status !== 'confirmed') throw conflict(`Booking is already ${booking!.status}`);
    if (batch!.departureAt <= new Date()) {
      throw conflict('This trek has already departed; contact the organizer');
    }

    const now = new Date();
    await tx
      .update(bookings)
      .set({
        status: 'cancelled',
        cancelledAt: now,
        cancelledBy: input.actorId,
        cancelReason: input.reason,
      })
      .where(eq(bookings.id, booking!.id));
    await tx
      .update(batches)
      .set({ confirmedSeats: sql`${batches.confirmedSeats} - ${booking!.quantity}` })
      .where(eq(batches.id, booking!.batchId));
    await tx.insert(bookingEvents).values({
      bookingId: booking!.id,
      eventType: input.by === 'customer' ? 'cancelled_by_customer' : 'cancelled_by_organizer',
      actorId: input.actorId,
      payload: { reason: input.reason, seatsReleased: booking!.quantity },
    });
    await enqueueEvent(tx, 'booking.cancelled', {
      organizerId: booking!.organizerId,
      bookingId: booking!.id,
      bookingReference: booking!.bookingReference,
      by: input.by,
    });
  });
}
