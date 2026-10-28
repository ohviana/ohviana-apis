import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { BOOKING_SOURCES, BOOKING_STATUSES } from '@ohviana/shared';
import { createdAt, id, inList, ts, updatedAt } from './_helpers';
import { batches, batchPickups, directLinks } from './batches';
import { pickupPoints } from './treks';
import { users } from './identity';

/** Immutable copy of what the customer agreed to at booking time. */
export interface BookingPolicySnapshot {
  trekTitle: string;
  organizerName: string;
  departureAt: string;
  returnAt: string;
  cancellationPolicy: string | null;
  inclusions: string[];
  exclusions: string[];
}

/** How commission was computed, frozen at booking time (never recalculated). */
export interface CommissionSnapshot {
  basis: 'MARKETPLACE_AGREED_RATE' | 'ORGANIZER_DIRECT_ZERO' | 'ORGANIZER_OFFLINE_ZERO';
  rateBps: number;
  computedOnPaise: number;
}

export const bookings = pgTable(
  'bookings',
  {
    id: id(),
    bookingReference: text('booking_reference').notNull(),
    batchId: uuid('batch_id').notNull(),
    organizerId: uuid('organizer_id').notNull(),
    userId: uuid('user_id').references(() => users.id),
    /** Server-determined, immutable attribution. */
    source: text('source', { enum: BOOKING_SOURCES }).notNull(),
    directLinkId: uuid('direct_link_id').references(() => directLinks.id),
    status: text('status', { enum: BOOKING_STATUSES }).notNull().default('confirmed'),
    quantity: integer('quantity').notNull(),
    unitPricePaise: bigint('unit_price_paise', { mode: 'number' }).notNull(),
    totalPaise: bigint('total_paise', { mode: 'number' }).notNull(),
    commissionRateBps: integer('commission_rate_bps').notNull(),
    commissionPaise: bigint('commission_paise', { mode: 'number' }).notNull(),
    commissionSnapshot: jsonb('commission_snapshot').$type<CommissionSnapshot>().notNull(),
    policySnapshot: jsonb('policy_snapshot').$type<BookingPolicySnapshot>().notNull(),
    pickupPointId: uuid('pickup_point_id'),
    // Lead contact (works for guest checkout and signed-in users alike)
    contactName: text('contact_name').notNull(),
    contactPhone: text('contact_phone').notNull(),
    contactEmail: text('contact_email'),
    emergencyContactName: text('emergency_contact_name'),
    emergencyContactPhone: text('emergency_contact_phone'),
    /**
     * SHA-256 of the secret handed to the customer at booking time; lets guests (no account)
     * view or cancel their booking. The secret itself is never stored.
     */
    accessTokenHash: text('access_token_hash'),
    cancelledAt: ts('cancelled_at'),
    cancelledBy: uuid('cancelled_by').references(() => users.id),
    cancelReason: text('cancel_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('bookings_reference_uq').on(t.bookingReference),
    foreignKey({
      name: 'bookings_batch_fk',
      columns: [t.batchId, t.organizerId],
      foreignColumns: [batches.id, batches.organizerId],
    }),
    // A chosen pickup must be one offered by this booking's batch.
    foreignKey({
      name: 'bookings_pickup_fk',
      columns: [t.batchId, t.pickupPointId],
      foreignColumns: [batchPickups.batchId, batchPickups.pickupPointId],
    }),
    index('bookings_batch_status_idx').on(t.batchId, t.status),
    index('bookings_org_created_idx').on(t.organizerId, t.createdAt.desc()),
    index('bookings_user_idx').on(t.userId, t.createdAt.desc()),
    check('bookings_source_ck', inList(t.source, BOOKING_SOURCES)),
    check('bookings_status_ck', inList(t.status, BOOKING_STATUSES)),
    check('bookings_quantity_ck', sql`${t.quantity} > 0`),
    check('bookings_unit_price_ck', sql`${t.unitPricePaise} >= 0`),
    check('bookings_total_ck', sql`${t.totalPaise} = ${t.unitPricePaise} * ${t.quantity}`),
    check(
      'bookings_commission_ck',
      sql`${t.commissionPaise} >= 0 and ${t.commissionPaise} <= ${t.totalPaise}
          and ${t.commissionRateBps} between 0 and 10000`,
    ),
    // PRD: only marketplace bookings carry commission (direct-link and organizer-added bookings
    // are zero) — enforced by the database.
    check(
      'bookings_direct_zero_commission_ck',
      sql`${t.source} = 'MARKETPLACE' or (${t.commissionPaise} = 0 and ${t.commissionRateBps} = 0)`,
    ),
    check(
      'bookings_direct_link_ck',
      sql`(${t.source} = 'ORGANIZER_DIRECT') = (${t.directLinkId} is not null)`,
    ),
    check('bookings_cancel_ck', sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`),
  ],
).enableRLS();

export const bookingGuests = pgTable(
  'booking_guests',
  {
    id: id(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    phone: text('phone'),
    age: integer('age'),
    gender: text('gender'),
    /** Order travellers were entered in (traveller 1, 2, …). */
    position: integer('position').notNull().default(0),
    /** Where this traveller boards (travellers in one booking can board at different stops). */
    pickupPointId: uuid('pickup_point_id').references(() => pickupPoints.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    index('booking_guests_booking_idx').on(t.bookingId),
    index('booking_guests_pickup_idx').on(t.pickupPointId),
    check('booking_guests_age_ck', sql`${t.age} is null or ${t.age} between 1 and 120`),
  ],
).enableRLS();

/** Append-only booking audit trail (created, cancelled, …). */
export const bookingEvents = pgTable(
  'booking_events',
  {
    id: id(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    actorId: uuid('actor_id').references(() => users.id),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('booking_events_booking_idx').on(t.bookingId, t.createdAt)],
).enableRLS();

/**
 * Idempotency-Key store (TDD §4): a retried request with the same key and scope returns the
 * stored response instead of creating a second booking.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.key] }),
    index('idempotency_keys_expires_idx').on(t.expiresAt),
  ],
).enableRLS();
