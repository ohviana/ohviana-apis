import { sql, type AnyColumn } from 'drizzle-orm';
import { check, index, pgTable, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_helpers';
import { bookingGuests, bookings } from './bookings';
import { users } from './identity';
import { organizers } from './organizers';

/** Star ratings are 1–5; an optional one is null when "not part of this trip". */
const stars = (name: string) => smallint(name);
const inRange = (column: AnyColumn) => sql`${column} between 1 and 5`;
const optionalInRange = (column: AnyColumn) => sql`${column} is null or ${column} between 1 and 5`;

/**
 * A traveller's review of a finished trip: one per traveller (booking guest), written after the
 * batch returned. Shown publicly at once; an admin can hide it, the organizer can reply once.
 */
export const reviews = pgTable(
  'reviews',
  {
    id: id(),
    bookingGuestId: uuid('booking_guest_id')
      .notNull()
      .references(() => bookingGuests.id, { onDelete: 'cascade' }),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    organizerId: uuid('organizer_id')
      .notNull()
      .references(() => organizers.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    /** Shown on the review: the traveller's first name, frozen when written. */
    authorName: text('author_name').notNull(),
    overall: stars('overall').notNull(),
    stay: stars('stay'),
    bus: stars('bus'),
    food: stars('food'),
    leader: stars('leader'),
    safety: stars('safety'),
    comment: text('comment'),
    reply: text('reply'),
    repliedAt: ts('replied_at'),
    repliedBy: uuid('replied_by').references(() => users.id, { onDelete: 'set null' }),
    hiddenAt: ts('hidden_at'),
    hiddenBy: uuid('hidden_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('reviews_guest_uq').on(t.bookingGuestId),
    index('reviews_organizer_idx').on(t.organizerId, t.createdAt.desc()),
    index('reviews_booking_idx').on(t.bookingId),
    check('reviews_overall_ck', inRange(t.overall)),
    check(
      'reviews_aspects_ck',
      sql`(${optionalInRange(t.stay)}) and (${optionalInRange(t.bus)})
          and (${optionalInRange(t.food)}) and (${optionalInRange(t.leader)})
          and (${optionalInRange(t.safety)})`,
    ),
    check('reviews_comment_ck', sql`char_length(${t.comment}) <= 1000`),
    check('reviews_reply_ck', sql`char_length(${t.reply}) <= 1000`),
    check('reviews_replied_ck', sql`(${t.reply} is null) = (${t.repliedAt} is null)`),
  ],
).enableRLS();
