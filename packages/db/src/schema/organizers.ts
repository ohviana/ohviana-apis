import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { ORGANIZER_ROLES, ORGANIZER_STATUSES } from '@ohviana/shared';
import { createdAt, id, inList, isSlug, ts, updatedAt } from './_helpers';
import { users } from './identity';

export const organizers = pgTable(
  'organizers',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    status: text('status', { enum: ORGANIZER_STATUSES }).notNull().default('pending'),
    // Public profile
    tagline: text('tagline'),
    description: text('description'),
    logoUrl: text('logo_url'),
    city: text('city'),
    // Contact (private)
    contactEmail: text('contact_email'),
    contactPhone: text('contact_phone'),
    // Verification & commercial terms
    gstin: text('gstin'),
    /** Agreed marketplace commission in basis points (750 = 7.5%). Direct bookings are always 0. */
    commissionRateBps: integer('commission_rate_bps').notNull().default(0),
    /** Non-sensitive verification data only. Payout/bank details belong in a dedicated store. */
    verificationMetadata: jsonb('verification_metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    reviewNote: text('review_note'),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    reviewedAt: ts('reviewed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('organizers_slug_uq').on(t.slug),
    index('organizers_status_idx').on(t.status),
    index('organizers_name_trgm_idx').using('gin', sql`${t.name} extensions.gin_trgm_ops`),
    check('organizers_status_ck', inList(t.status, ORGANIZER_STATUSES)),
    check('organizers_slug_ck', isSlug(t.slug)),
    check('organizers_commission_ck', sql`${t.commissionRateBps} between 0 and 10000`),
  ],
).enableRLS();

export const organizerMembers = pgTable(
  'organizer_members',
  {
    organizerId: uuid('organizer_id')
      .notNull()
      .references(() => organizers.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ORGANIZER_ROLES }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizerId, t.userId] }),
    index('organizer_members_user_idx').on(t.userId),
    check('organizer_members_role_ck', inList(t.role, ORGANIZER_ROLES)),
    // The owner is the one person who created the organizer; co-owners share their access.
    uniqueIndex('organizer_members_one_owner_uq')
      .on(t.organizerId)
      .where(sql`${t.role} = 'owner'`),
  ],
).enableRLS();

/**
 * Trek leads an owner took access away from, by mobile. Signing in again doesn't bring access
 * back; naming them as a lead on a batch again does (the row is deleted).
 */
export const organizerLeadRevocations = pgTable(
  'organizer_lead_revocations',
  {
    organizerId: uuid('organizer_id')
      .notNull()
      .references(() => organizers.id, { onDelete: 'cascade' }),
    /** E.164. */
    phone: text('phone').notNull(),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.organizerId, t.phone] })],
).enableRLS();
