import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { BATCH_STATUSES } from '@ohviana/shared';
import { createdAt, id, inList, ts, updatedAt } from './_helpers';
import { users } from './identity';
import { organizers } from './organizers';
import { organizerTreks, pickupPoints } from './treks';

export interface TripLead {
  name: string;
  /** E.164. */
  phone: string;
}

/**
 * A dated, bookable departure of an organizer trek. Only batches are bookable.
 * `organizer_id` is denormalized (and FK-checked against the template) for tenant isolation.
 */
export const batches = pgTable(
  'batches',
  {
    id: id(),
    organizerTrekId: uuid('organizer_trek_id').notNull(),
    organizerId: uuid('organizer_id').notNull(),
    /** Generated once at creation, e.g. "RCB_Kudremukh_25th_Sept_Batch_1"; never renamed. */
    name: text('name').notNull(),
    departureAt: ts('departure_at').notNull(),
    returnAt: ts('return_at').notNull(),
    bookingCutoffAt: ts('booking_cutoff_at').notNull(),
    pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
    capacity: integer('capacity').notNull(),
    /** Seats held by confirmed bookings. Mutated only inside the booking transaction. */
    confirmedSeats: integer('confirmed_seats').notNull().default(0),
    maxSeatsPerBooking: integer('max_seats_per_booking').notNull().default(10),
    status: text('status', { enum: BATCH_STATUSES }).notNull().default('draft'),
    notes: text('notes'),
    /** Who leads this departure on the ground, e.g. [{ name: 'Ravi', phone: '+9198…' }]. */
    leads: jsonb('leads').$type<TripLead[]>().notNull().default([]),
    publishedAt: ts('published_at'),
    cancelledAt: ts('cancelled_at'),
    cancelReason: text('cancel_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'batches_trek_fk',
      columns: [t.organizerTrekId, t.organizerId],
      foreignColumns: [organizerTreks.id, organizerTreks.organizerId],
    }),
    unique('batches_id_org_uq').on(t.id, t.organizerId),
    unique('batches_id_trek_uq').on(t.id, t.organizerTrekId),
    uniqueIndex('batches_org_name_uq').on(t.organizerId, t.name),
    index('batches_departure_idx').on(t.status, t.departureAt),
    index('batches_trek_idx').on(t.organizerTrekId, t.departureAt),
    index('batches_org_idx').on(t.organizerId, t.departureAt),
    // "Which batches does this mobile lead?" (leads @> '[{"phone": …}]').
    index('batches_leads_idx').using('gin', sql`${t.leads} jsonb_path_ops`),
    check('batches_status_ck', inList(t.status, BATCH_STATUSES)),
    check('batches_dates_ck', sql`${t.returnAt} > ${t.departureAt}`),
    check('batches_cutoff_ck', sql`${t.bookingCutoffAt} <= ${t.departureAt}`),
    check('batches_price_ck', sql`${t.pricePaise} >= 0`),
    check('batches_capacity_ck', sql`${t.capacity} > 0`),
    check(
      'batches_seats_ck',
      sql`${t.confirmedSeats} >= 0 and ${t.confirmedSeats} <= ${t.capacity}`,
    ),
    check('batches_max_per_booking_ck', sql`${t.maxSeatsPerBooking} > 0`),
  ],
).enableRLS();

/** Which template pickup points a batch uses, and the pickup time for this departure. */
export const batchPickups = pgTable(
  'batch_pickups',
  {
    batchId: uuid('batch_id').notNull(),
    pickupPointId: uuid('pickup_point_id').notNull(),
    organizerTrekId: uuid('organizer_trek_id').notNull(),
    pickupAt: ts('pickup_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.batchId, t.pickupPointId] }),
    // Both FKs share organizer_trek_id, so a batch can only use its own template's pickups.
    foreignKey({
      name: 'batch_pickups_batch_fk',
      columns: [t.batchId, t.organizerTrekId],
      foreignColumns: [batches.id, batches.organizerTrekId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'batch_pickups_point_fk',
      columns: [t.pickupPointId, t.organizerTrekId],
      foreignColumns: [pickupPoints.id, pickupPoints.organizerTrekId],
    }).onDelete('cascade'),
  ],
).enableRLS();

/**
 * Organizer-shared booking links. `batch_id` null = organizer-level branded link (any of the
 * organizer's batches); set = link for one batch. Bookings through a valid link are
 * ORGANIZER_DIRECT with zero marketplace commission.
 */
export const directLinks = pgTable(
  'direct_links',
  {
    id: id(),
    organizerId: uuid('organizer_id')
      .notNull()
      .references(() => organizers.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id'),
    token: text('token').notNull(),
    label: text('label'),
    active: boolean('active').notNull().default(true),
    expiresAt: ts('expires_at'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('direct_links_token_uq').on(t.token),
    foreignKey({
      name: 'direct_links_batch_fk',
      columns: [t.batchId, t.organizerId],
      foreignColumns: [batches.id, batches.organizerId],
    }).onDelete('cascade'),
    index('direct_links_org_idx').on(t.organizerId, t.active),
    check('direct_links_token_ck', sql`length(${t.token}) >= 16`),
  ],
).enableRLS();
