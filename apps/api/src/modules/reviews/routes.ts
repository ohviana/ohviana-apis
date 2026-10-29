import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  AdminReview,
  AdminReviewList,
  AdminReviewListQuery,
  CreateReviewRequest,
  ErrorResponse,
  IdParams,
  OrganizerReview,
  OrganizerReviewList,
  OwnReview,
  PublicReviewPage,
  ReplyToReviewRequest,
  ReviewListQuery,
  ReviewTripList,
  SlugParams,
} from '@ohviana/contracts';
import { AppError } from '../../lib/errors';
import { requireAuth, requireOrganizer } from '../../plugins/auth';
import {
  adminReviews,
  createReview,
  listReviewTrips,
  organizerReviews,
  publicReviews,
  replyToReview,
  setReviewHidden,
} from './service';

const security = [{ bearerAuth: [] }];
const errors = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  409: ErrorResponse,
};

/** Travellers review finished trips (/v1/me/…); anyone reads an organizer's reviews. */
export const reviewRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['reviews'];

  app.get(
    '/me/review-trips',
    {
      onRequest: app.guards.user,
      schema: {
        tags,
        summary: 'Trips the signed-in traveller was on (by their phone) and their reviews',
        security,
        response: { 200: ReviewTripList, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      if (!auth.phoneVerified || !auth.phone) return { phoneVerified: false, items: [] };
      return { phoneVerified: true, items: await listReviewTrips(app.db, auth.phone) };
    },
  );

  app.post(
    '/me/reviews',
    {
      onRequest: app.guards.user,
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
      schema: {
        tags,
        summary: 'Review a finished trip (once per traveller)',
        security,
        body: CreateReviewRequest,
        response: { 201: OwnReview, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      if (!auth.phoneVerified || !auth.phone) {
        throw new AppError('FORBIDDEN', 'Sign in with your mobile number to review your trip');
      }
      const review = await createReview(app.db, {
        userId: auth.userId,
        phone: auth.phone,
        body: request.body,
      });
      return reply.status(201).send(review);
    },
  );

  app.get(
    '/organizers/:slug/reviews',
    {
      schema: {
        tags,
        summary: "An organizer's reviews (newest first) and their score",
        params: SlugParams,
        querystring: ReviewListQuery,
        response: { 200: PublicReviewPage, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'public, max-age=60');
      return publicReviews(app.db, request.params.slug, request.query);
    },
  );
};

/** Under /v1/organizer: the active organizer's reviews and their one public reply each. */
export const organizerReviewRoutes: FastifyPluginAsyncZod = async (app) => {
  const g = app.guards.organizer;
  const tags = ['organizer'];

  app.get(
    '/reviews',
    {
      onRequest: g('bookings:read'),
      schema: {
        tags,
        summary: 'Reviews of this organizer, newest first (including hidden ones)',
        security,
        querystring: ReviewListQuery,
        response: { 200: OrganizerReviewList, ...errors },
      },
    },
    async (request) =>
      organizerReviews(app.db, requireOrganizer(request).organizerId, request.query),
  );

  app.post(
    '/reviews/:id/reply',
    {
      onRequest: g('bookings:manage'),
      schema: {
        tags,
        summary: 'Reply publicly to a review (once)',
        security,
        params: IdParams,
        body: ReplyToReviewRequest,
        response: { 200: OrganizerReview, ...errors },
      },
    },
    async (request) =>
      replyToReview(app.db, {
        organizerId: requireOrganizer(request).organizerId,
        reviewId: request.params.id,
        userId: requireAuth(request).userId,
        reply: request.body.reply,
      }),
  );
};

/** Under /v1/admin: every review, and hiding abusive or fake ones. */
export const adminReviewRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.guards.admin);
  const tags = ['admin'];

  app.get(
    '/reviews',
    {
      schema: {
        tags,
        summary: 'All reviews, newest first',
        security,
        querystring: AdminReviewListQuery,
        response: { 200: AdminReviewList, ...errors },
      },
    },
    async (request) => adminReviews(app.db, request.query),
  );

  for (const [action, hidden] of [
    ['hide', true],
    ['unhide', false],
  ] as const) {
    app.post(
      `/reviews/:id/${action}`,
      {
        schema: {
          tags,
          summary: hidden
            ? 'Hide a review (not shown, not counted in the score)'
            : 'Show a hidden review again',
          security,
          params: IdParams,
          response: { 200: AdminReview, ...errors },
        },
      },
      async (request) =>
        setReviewHidden(app.db, {
          reviewId: request.params.id,
          hidden,
          actorId: requireAuth(request).userId,
        }),
    );
  }
};
