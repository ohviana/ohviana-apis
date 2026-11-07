import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_helpers';

/**
 * Application profile for an authenticated person. `id` is the Supabase `auth.users.id` for
 * people who first signed in with Supabase; accounts created by the API (phone code, the
 * retired email + password) have their own id and gain `auth_user_id` when their owner later
 * signs in with Google or an email code for the same, proven email.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    /** The Supabase `auth.users.id` linked to this account, when it differs from `id`. */
    authUserId: uuid('auth_user_id'),
    email: text('email'),
    fullName: text('full_name'),
    phone: text('phone'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`),
    uniqueIndex('users_auth_user_id_uq').on(t.authUserId),
    // Phone sign-in finds the account by its number.
    index('users_phone_idx').on(t.phone),
  ],
).enableRLS();

/** Platform administrators. Admin access is a separate, explicit grant (TDD §5). */
export const platformAdmins = pgTable('platform_admins', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  grantedBy: uuid('granted_by').references(() => users.id),
  createdAt: createdAt(),
}).enableRLS();

/** Append-only log of every admin action (TDD §7 "audit admin actions"). */
export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: id(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('admin_audit_entity_idx').on(t.entityType, t.entityId, t.createdAt)],
).enableRLS();

/**
 * RETIRED: email + password sign-in, replaced by Google and email codes (Supabase). Nothing
 * reads or writes it any more; kept so existing rows aren't lost until a migration drops it.
 */
export const userCredentials = pgTable('user_credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}).enableRLS();

/**
 * One-time sign-in codes sent by SMS (phone sign-in at checkout). Stores only an HMAC of the
 * code; a code is single-use, short-lived and locked after a few wrong guesses.
 */
export const phoneOtps = pgTable(
  'phone_otps',
  {
    id: id(),
    /** E.164, e.g. +919876543210. */
    phone: text('phone').notNull(),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('phone_otps_phone_created_idx').on(t.phone, t.createdAt.desc()),
    check('phone_otps_attempts_ck', sql`${t.attempts} >= 0`),
  ],
).enableRLS();
