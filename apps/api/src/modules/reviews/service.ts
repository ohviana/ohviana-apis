import { and, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import {
  batches,
  bookingGuests,
  bookings,
  catalogTreks,
  organizers,
  organizerTreks,
  reviews,
  type Database,
} from '@ohviana/db';
import type {
  AdminReview,
  AdminReviewListQuery,
  CreateReviewRequest,
  OrganizerRating,
  OrganizerReview,
  OwnReview,
  PublicReview,
  PublicReviewPage,
  RatingSummary,
  ReviewListQuery,
  ReviewTrip,
} from '@ohviana/contracts';
import { recordAdminAction } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';
import { decodeCursor, toPage } from '../../lib/pagination';

/** Departures that went ahead: a cancelled batch can't be reviewed. */
const RAN = ['published', 'completed'] as const;

/**
 * An organizer's score over visible reviews, for use inside a query that selects from
 * `organizers`. Null until they have a review.
 *
 * The outer column is spelled out in full: in a single-table select Drizzle renders
 * `organizers.id` as a bare "id", which inside this subquery would mean the review's id.
 */
export const organizerRating = () => sql<OrganizerRating | null>`(
  select case when count(*) = 0 then null else json_build_object(
    'average', round(avg(r.overall), 1)::float8, 'count', count(*)::int) end
  from ${reviews} r
  where r.organizer_id = ${sql.identifier('organizers')}.${sql.identifier('id')}
    and r.hidden_at is null
)`;

type ReviewRow = typeof reviews.$inferSelect;

const aspectsOf = (r: ReviewRow) => ({
  stay: r.stay,
  bus: r.bus,
  food: r.food,
  leader: r.leader,
  safety: r.safety,
});

function toOwn(r: ReviewRow): OwnReview {
  return {
    id: r.id,
    overall: r.overall,
    aspects: aspectsOf(r),
    comment: r.comment,
    createdAt: r.createdAt.toISOString(),
  };
}

/** The first name, as shown on a public review. */
const firstName = (fullName: string) => fullName.trim().split(/\s+/)[0] ?? fullName;

// ---------- Customers ----------

/** Every trip the traveller with this (verified) mobile was on, newest first. */
export async function listReviewTrips(
  db: Database,
  phone: string,
  now = new Date(),
): Promise<ReviewTrip[]> {
  const rows = await db
    .select({
      guestId: bookingGuests.id,
      travellerName: bookingGuests.fullName,
      bookingReference: bookings.bookingReference,
      trekName: catalogTreks.name,
      organizer: { name: organizers.name, slug: organizers.slug },
      departureAt: batches.departureAt,
      returnAt: batches.returnAt,
      review: reviews,
    })
    .from(bookingGuests)
    .innerJoin(bookings, eq(bookings.id, bookingGuests.bookingId))
    .innerJoin(batches, eq(batches.id, bookings.batchId))
    .innerJoin(organizerTreks, eq(organizerTreks.id, batches.organizerTrekId))
    .innerJoin(catalogTreks, eq(catalogTreks.id, organizerTreks.catalogTrekId))
    .innerJoin(organizers, eq(organizers.id, bookings.organizerId))
    .leftJoin(reviews, eq(reviews.bookingGuestId, bookingGuests.id))
    .where(
      and(
        eq(bookingGuests.phone, phone),
        eq(bookings.status, 'confirmed'),
        inArray(batches.status, RAN),
      ),
    )
    .orderBy(desc(batches.departureAt), desc(bookingGuests.id))
    .limit(50);

  return rows.map((r) => ({
    bookingGuestId: r.guestId,
    travellerName: r.travellerName,
    bookingReference: r.bookingReference,
    trekName: r.trekName,
    organizer: r.organizer,
    departureAt: r.departureAt.toISOString(),
    returnAt: r.returnAt.toISOString(),
    canReview: !r.review && r.returnAt <= now,
    review: r.review ? toOwn(r.review) : null,
  }));
}

/**
 * A traveller reviews a trip once it is over. Only the traveller whose mobile is on the booking
 * (proven by their phone sign-in) can write it, once.
 */
export async function createReview(
  db: Database,
  input: { userId: string; phone: string; body: CreateReviewRequest },
  now = new Date(),
): Promise<OwnReview> {
  const { body } = input;
  const [trip] = await db
    .select({
      guest: { id: bookingGuests.id, fullName: bookingGuests.fullName },
      bookingId: bookings.id,
      organizerId: bookings.organizerId,
      bookingStatus: bookings.status,
      batchStatus: batches.status,
      returnAt: batches.returnAt,
    })
    .from(bookingGuests)
    .innerJoin(bookings, eq(bookings.id, bookingGuests.bookingId))
    .innerJoin(batches, eq(batches.id, bookings.batchId))
    .where(and(eq(bookingGuests.id, body.bookingGuestId), eq(bookingGuests.phone, input.phone)));
  // Someone else's traveller looks the same as a missing one.
  if (!trip) throw notFound('Trip');
  if (trip.bookingStatus !== 'confirmed' || !RAN.some((s) => s === trip.batchStatus)) {
    throw conflict('This trip was cancelled, so it cannot be reviewed');
  }
  if (trip.returnAt > now) throw conflict('You can review this trip once it is over');

  const [created] = await db
    .insert(reviews)
    .values({
      bookingGuestId: trip.guest.id,
      bookingId: trip.bookingId,
      organizerId: trip.organizerId,
      authorId: input.userId,
      authorName: firstName(trip.guest.fullName),
      overall: body.overall,
      stay: body.aspects.stay ?? null,
      bus: body.aspects.bus ?? null,
      food: body.aspects.food ?? null,
      leader: body.aspects.leader ?? null,
      safety: body.aspects.safety ?? null,
      comment: body.comment ?? null,
    })
    .onConflictDoNothing({ target: reviews.bookingGuestId })
    .returning();
  if (!created) throw conflict('You have already reviewed this trip');
  return toOwn(created);
}

// ---------- Listing ----------

function reviewQuery(db: Database) {
  return db
    .select({
      review: reviews,
      trekName: catalogTreks.name,
      tripDate: batches.departureAt,
      bookingReference: bookings.bookingReference,
      organizer: { id: organizers.id, name: organizers.name, slug: organizers.slug },
    })
    .from(reviews)
    .innerJoin(bookings, eq(bookings.id, reviews.bookingId))
    .innerJoin(batches, eq(batches.id, bookings.batchId))
    .innerJoin(organizerTreks, eq(organizerTreks.id, batches.organizerTrekId))
    .innerJoin(catalogTreks, eq(catalogTreks.id, organizerTreks.catalogTrekId))
    .innerJoin(organizers, eq(organizers.id, reviews.organizerId));
}

type ListedRow = Awaited<ReturnType<ReturnType<typeof reviewQuery>['where']>>[number];

/** Newest first, keyset-paginated on (created_at, id). */
async function listPage(db: Database, where: SQL[], q: ReviewListQuery) {
  if (q.cursor) {
    const [createdAt, id] = decodeCursor(q.cursor, 2);
    where.push(
      sql`(${reviews.createdAt}, ${reviews.id}) < (${createdAt}::timestamptz, ${id}::uuid)`,
    );
  }
  const rows = await reviewQuery(db)
    .where(and(...where))
    .orderBy(desc(reviews.createdAt), desc(reviews.id))
    .limit(q.limit + 1);
  return toPage(rows, q.limit, (r) => [r.review.createdAt.toISOString(), r.review.id]);
}

function toPublic(r: ListedRow): PublicReview {
  const v = r.review;
  return {
    id: v.id,
    authorName: v.authorName,
    overall: v.overall,
    aspects: aspectsOf(v),
    comment: v.comment,
    trekName: r.trekName,
    tripDate: r.tripDate.toISOString(),
    reply: v.reply && v.repliedAt ? { text: v.reply, repliedAt: v.repliedAt.toISOString() } : null,
    createdAt: v.createdAt.toISOString(),
  };
}

function toOrganizerReview(r: ListedRow): OrganizerReview {
  return { ...toPublic(r), bookingReference: r.bookingReference, hidden: !!r.review.hiddenAt };
}

async function ratingSummary(db: Database, organizerId: string): Promise<RatingSummary | null> {
  const avg = (column: SQL | typeof reviews.overall) =>
    sql<number | null>`round(avg(${column}), 1)::float8`;
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      average: avg(reviews.overall),
      stay: avg(sql`${reviews.stay}`),
      bus: avg(sql`${reviews.bus}`),
      food: avg(sql`${reviews.food}`),
      leader: avg(sql`${reviews.leader}`),
      safety: avg(sql`${reviews.safety}`),
    })
    .from(reviews)
    .where(and(eq(reviews.organizerId, organizerId), isNull(reviews.hiddenAt)));
  if (!row || row.count === 0 || row.average === null) return null;
  const { count, average, ...aspects } = row;
  return { count, average, aspects };
}

/** An approved organizer's visible reviews, with their score on the first page. */
export async function publicReviews(
  db: Database,
  slug: string,
  q: ReviewListQuery,
): Promise<PublicReviewPage> {
  const [org] = await db
    .select({ id: organizers.id })
    .from(organizers)
    .where(and(eq(organizers.slug, slug), eq(organizers.status, 'approved')));
  if (!org) throw notFound('Organizer');
  const [page, summary] = await Promise.all([
    listPage(db, [eq(reviews.organizerId, org.id), isNull(reviews.hiddenAt)], q),
    ratingSummary(db, org.id),
  ]);
  return { items: page.items.map(toPublic), nextCursor: page.nextCursor, summary };
}

// ---------- Organizers ----------

/** All of an organizer's reviews, including ones an admin hid (flagged). */
export async function organizerReviews(db: Database, organizerId: string, q: ReviewListQuery) {
  const page = await listPage(db, [eq(reviews.organizerId, organizerId)], q);
  return { items: page.items.map(toOrganizerReview), nextCursor: page.nextCursor };
}

/** One public reply per review; it can't be edited afterwards. */
export async function replyToReview(
  db: Database,
  input: { organizerId: string; reviewId: string; userId: string; reply: string },
): Promise<OrganizerReview> {
  const [updated] = await db
    .update(reviews)
    .set({ reply: input.reply, repliedAt: new Date(), repliedBy: input.userId })
    .where(
      and(
        eq(reviews.id, input.reviewId),
        eq(reviews.organizerId, input.organizerId),
        isNull(reviews.reply),
      ),
    )
    .returning({ id: reviews.id });
  if (!updated) {
    const [exists] = await db
      .select({ id: reviews.id })
      .from(reviews)
      .where(and(eq(reviews.id, input.reviewId), eq(reviews.organizerId, input.organizerId)));
    if (!exists) throw notFound('Review');
    throw conflict('You have already replied to this review');
  }
  const [row] = await reviewQuery(db).where(eq(reviews.id, input.reviewId));
  return toOrganizerReview(row!);
}

// ---------- Admin ----------

export async function adminReviews(db: Database, q: AdminReviewListQuery) {
  const where: SQL[] = [];
  if (q.hidden === 'true') where.push(isNotNull(reviews.hiddenAt));
  if (q.hidden === 'false') where.push(isNull(reviews.hiddenAt));
  const page = await listPage(db, where, q);
  return {
    items: page.items.map((r): AdminReview => ({
      ...toOrganizerReview(r),
      organizer: r.organizer,
    })),
    nextCursor: page.nextCursor,
  };
}

/** Hides (or shows again) an abusive or fake review. Audited. */
export async function setReviewHidden(
  db: Database,
  input: { reviewId: string; hidden: boolean; actorId: string },
): Promise<AdminReview> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(reviews)
      .set(
        input.hidden
          ? { hiddenAt: sql`coalesce(${reviews.hiddenAt}, now())`, hiddenBy: input.actorId }
          : { hiddenAt: null, hiddenBy: null },
      )
      .where(eq(reviews.id, input.reviewId))
      .returning({ id: reviews.id, organizerId: reviews.organizerId });
    if (!row) throw notFound('Review');
    await recordAdminAction(tx, {
      actorId: input.actorId,
      action: input.hidden ? 'review.hide' : 'review.unhide',
      entityType: 'review',
      entityId: row.id,
      payload: { organizerId: row.organizerId },
    });
  });
  const [row] = await reviewQuery(db).where(eq(reviews.id, input.reviewId));
  return { ...toOrganizerReview(row!), organizer: row!.organizer };
}
