import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { CONTENT_STATUSES, DIFFICULTIES } from '@ohviana/shared';
import { createdAt, id, inList, isSlug, updatedAt } from './_helpers';
import { catalogTrekRequests, catalogTreks } from './catalog';
import { organizers } from './organizers';

export interface ItineraryDay {
  day: number;
  title: string;
  details?: string;
}

/** An organizer's reusable trek offering (template). Batches are dated departures of it. */
export const organizerTreks = pgTable(
  'organizer_treks',
  {
    id: id(),
    organizerId: uuid('organizer_id')
      .notNull()
      .references(() => organizers.id, { onDelete: 'cascade' }),
    /** May be null only while a draft waits on a catalog request; required to publish. */
    catalogTrekId: uuid('catalog_trek_id').references(() => catalogTreks.id),
    catalogTrekRequestId: uuid('catalog_trek_request_id').references(() => catalogTrekRequests.id),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    summary: text('summary'),
    durationDays: integer('duration_days'),
    /** This organizer's route can differ from the catalog's (e.g. a harder approach). */
    difficulty: text('difficulty', { enum: DIFFICULTIES }),
    maxAltitudeM: integer('max_altitude_m'),
    /** Where the trip starts, e.g. "Bengaluru" (pickup points are set per batch). */
    startPoint: text('start_point'),
    itinerary: jsonb('itinerary').$type<ItineraryDay[]>().notNull().default([]),
    inclusions: jsonb('inclusions').$type<string[]>().notNull().default([]),
    exclusions: jsonb('exclusions').$type<string[]>().notNull().default([]),
    thingsToCarry: jsonb('things_to_carry').$type<string[]>().notNull().default([]),
    /** Customer-facing cancellation terms; snapshotted onto each booking. */
    cancellationPolicy: text('cancellation_policy'),
    status: text('status', { enum: CONTENT_STATUSES }).notNull().default('draft'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('organizer_treks_org_slug_uq').on(t.organizerId, t.slug),
    // Target for composite FKs that guarantee tenant consistency downstream.
    unique('organizer_treks_id_org_uq').on(t.id, t.organizerId),
    index('organizer_treks_catalog_idx').on(t.catalogTrekId, t.status),
    check('organizer_treks_status_ck', inList(t.status, CONTENT_STATUSES)),
    check('organizer_treks_difficulty_ck', inList(t.difficulty, DIFFICULTIES)),
    check('organizer_treks_altitude_ck', sql`${t.maxAltitudeM} is null or ${t.maxAltitudeM} > 0`),
    check('organizer_treks_slug_ck', isSlug(t.slug)),
    check(
      'organizer_treks_catalog_required_ck',
      sql`${t.status} = 'draft' or ${t.catalogTrekId} is not null`,
    ),
    check('organizer_treks_duration_ck', sql`${t.durationDays} is null or ${t.durationDays} > 0`),
  ],
).enableRLS();

/** Reusable pickup locations of a trek template (PRD: pickup shown when comparing batches). */
export const pickupPoints = pgTable(
  'pickup_points',
  {
    id: id(),
    organizerTrekId: uuid('organizer_trek_id').notNull(),
    organizerId: uuid('organizer_id').notNull(),
    name: text('name').notNull(),
    address: text('address'),
    landmark: text('landmark'),
    mapsUrl: text('maps_url'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'pickup_points_trek_fk',
      columns: [t.organizerTrekId, t.organizerId],
      foreignColumns: [organizerTreks.id, organizerTreks.organizerId],
    }).onDelete('cascade'),
    unique('pickup_points_id_trek_uq').on(t.id, t.organizerTrekId),
    index('pickup_points_trek_idx').on(t.organizerTrekId, t.sortOrder),
  ],
).enableRLS();
