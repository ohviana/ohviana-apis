import { z } from 'zod';
import { PaginationQuery, Uuid, paginated } from './common';

const Timestamp = z.iso.datetime();
const Stars = z.number().int().min(1).max(5);

/**
 * Side ratings (REVIEW_ASPECTS). On input a missing one means "not part of this trip"
 * (e.g. no stay on a day trek); on output it is null.
 */
export const ReviewAspectsInput = z.object({
  stay: Stars.optional(),
  bus: Stars.optional(),
  food: Stars.optional(),
  leader: Stars.optional(),
  safety: Stars.optional(),
});

export const ReviewAspects = z.object({
  stay: Stars.nullable(),
  bus: Stars.nullable(),
  food: Stars.nullable(),
  leader: Stars.nullable(),
  safety: Stars.nullable(),
});
export type ReviewAspects = z.infer<typeof ReviewAspects>;

/** An organizer's score: average of overall ratings (one decimal) over visible reviews. */
export const OrganizerRating = z.object({
  average: z.number(),
  count: z.number().int(),
});
export type OrganizerRating = z.infer<typeof OrganizerRating>;

export const RatingSummary = OrganizerRating.extend({
  /** Average per side rating, null when nobody rated it. */
  aspects: z.object({
    stay: z.number().nullable(),
    bus: z.number().nullable(),
    food: z.number().nullable(),
    leader: z.number().nullable(),
    safety: z.number().nullable(),
  }),
});
export type RatingSummary = z.infer<typeof RatingSummary>;

// ---------- Customers ----------

export const CreateReviewRequest = z.object({
  /** The traveller on the booking who is reviewing (their phone must be the signed-in one). */
  bookingGuestId: Uuid,
  overall: Stars,
  aspects: ReviewAspectsInput.default({}),
  comment: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((c) => c || undefined),
});
export type CreateReviewRequest = z.infer<typeof CreateReviewRequest>;

export const OwnReview = z.object({
  id: Uuid,
  overall: Stars,
  aspects: ReviewAspects,
  comment: z.string().nullable(),
  createdAt: Timestamp,
});
export type OwnReview = z.infer<typeof OwnReview>;

/** A trip the signed-in traveller was on, and their review of it (if any). */
export const ReviewTrip = z.object({
  bookingGuestId: Uuid,
  travellerName: z.string(),
  bookingReference: z.string(),
  trekName: z.string(),
  organizer: z.object({ name: z.string(), slug: z.string() }),
  departureAt: Timestamp,
  returnAt: Timestamp,
  /** True once the trip has returned (and the review isn't written yet). */
  canReview: z.boolean(),
  review: OwnReview.nullable(),
});
export type ReviewTrip = z.infer<typeof ReviewTrip>;

export const ReviewTripList = z.object({
  /**
   * Reviews belong to the traveller whose mobile is on the booking, proven by a phone-code
   * sign-in. False when the caller signed in another way: they must sign in with their phone.
   */
  phoneVerified: z.boolean(),
  items: z.array(ReviewTrip),
});
export type ReviewTripList = z.infer<typeof ReviewTripList>;

// ---------- Public ----------

export const PublicReview = z.object({
  id: Uuid,
  authorName: z.string(),
  overall: Stars,
  aspects: ReviewAspects,
  comment: z.string().nullable(),
  trekName: z.string(),
  /** When the trip departed (shown as month + year). */
  tripDate: Timestamp,
  reply: z.object({ text: z.string(), repliedAt: Timestamp }).nullable(),
  createdAt: Timestamp,
});
export type PublicReview = z.infer<typeof PublicReview>;

export const ReviewListQuery = PaginationQuery;
export type ReviewListQuery = z.infer<typeof ReviewListQuery>;

export const PublicReviewPage = paginated(PublicReview).extend({
  /** Null until the organizer has a visible review. */
  summary: RatingSummary.nullable(),
});
export type PublicReviewPage = z.infer<typeof PublicReviewPage>;

// ---------- Organizers ----------

export const OrganizerReview = PublicReview.extend({
  bookingReference: z.string(),
  /** Hidden by an Ohviana admin: not shown publicly and not counted in the score. */
  hidden: z.boolean(),
});
export type OrganizerReview = z.infer<typeof OrganizerReview>;

export const OrganizerReviewList = paginated(OrganizerReview);

export const ReplyToReviewRequest = z.object({ reply: z.string().trim().min(2).max(1000) });
export type ReplyToReviewRequest = z.infer<typeof ReplyToReviewRequest>;

// ---------- Admin ----------

export const AdminReviewListQuery = PaginationQuery.extend({
  hidden: z.enum(['true', 'false']).optional(),
});
export type AdminReviewListQuery = z.infer<typeof AdminReviewListQuery>;

export const AdminReview = OrganizerReview.extend({
  organizer: z.object({ id: Uuid, name: z.string(), slug: z.string() }),
});
export type AdminReview = z.infer<typeof AdminReview>;

export const AdminReviewList = paginated(AdminReview);
