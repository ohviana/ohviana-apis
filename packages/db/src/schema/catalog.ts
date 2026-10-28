import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { CATALOG_REQUEST_STATUSES, CONTENT_STATUSES, DIFFICULTIES } from '@ohviana/shared';
import { createdAt, id, inList, isSlug, ts, updatedAt } from './_helpers';
import { users } from './identity';
import { organizers } from './organizers';

/** Canonical, Ohviana-curated trek/destination used for search and SEO (e.g. Kudremukh). */
export const catalogTreks = pgTable(
  'catalog_treks',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    state: text('state'),
    region: text('region'),
    district: text('district'),
    difficulty: text('difficulty', { enum: DIFFICULTIES }),
    summary: text('summary'),
    description: text('description'),
    maxAltitudeM: integer('max_altitude_m'),
    heroImageUrl: text('hero_image_url'),
    status: text('status', { enum: CONTENT_STATUSES }).notNull().default('draft'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('catalog_treks_slug_uq').on(t.slug),
    index('catalog_treks_status_idx').on(t.status),
    index('catalog_treks_name_trgm_idx').using('gin', sql`${t.name} extensions.gin_trgm_ops`),
    check('catalog_treks_status_ck', inList(t.status, CONTENT_STATUSES)),
    check('catalog_treks_difficulty_ck', inList(t.difficulty, DIFFICULTIES)),
    check('catalog_treks_slug_ck', isSlug(t.slug)),
    check('catalog_treks_altitude_ck', sql`${t.maxAltitudeM} is null or ${t.maxAltitudeM} > 0`),
  ],
).enableRLS();

/** An organizer asks admins to add a missing canonical trek (PRD organizer journey step 2). */
export const catalogTrekRequests = pgTable(
  'catalog_trek_requests',
  {
    id: id(),
    organizerId: uuid('organizer_id')
      .notNull()
      .references(() => organizers.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    state: text('state'),
    region: text('region'),
    district: text('district'),
    notes: text('notes'),
    status: text('status', { enum: CATALOG_REQUEST_STATUSES }).notNull().default('pending'),
    /** Set when approved: the catalog trek created for (or matched to) this request. */
    catalogTrekId: uuid('catalog_trek_id').references(() => catalogTreks.id),
    reviewNote: text('review_note'),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    reviewedAt: ts('reviewed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('catalog_trek_requests_status_idx').on(t.status, t.createdAt),
    index('catalog_trek_requests_org_idx').on(t.organizerId),
    check('catalog_trek_requests_status_ck', inList(t.status, CATALOG_REQUEST_STATUSES)),
    check(
      'catalog_trek_requests_approved_ck',
      sql`${t.status} <> 'approved' or ${t.catalogTrekId} is not null`,
    ),
  ],
).enableRLS();
