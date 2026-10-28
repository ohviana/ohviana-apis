import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  DirectLinkLanding,
  ErrorResponse,
  IdParams,
  OrganizerSearchQuery,
  PublicBatch,
  PublicBatchList,
  PublicBatchQuery,
  BatchSearchQuery,
  PublicOrganizerDetail,
  PublicOrganizerList,
  PublicTrekDetail,
  PublicTrekList,
  SlugParams,
  TokenParams,
  TrekSearchQuery,
} from '@ohviana/contracts';
import {
  directLanding,
  getOrganizer,
  getPublicBatch,
  getTrek,
  organizerBatches,
  searchOrganizers,
  searchBatches,
  searchTreks,
  trekBatches,
} from './service';
import { LIMITS } from '../../plugins/rate-limit';

const tags = ['public'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 404: ErrorResponse };

/**
 * Short shared caching for anonymous reads. Seat counts may be ~30s stale here; checkout
 * re-validates availability server-side.
 */
const PUBLIC_CACHE = 'public, max-age=0, s-maxage=30, stale-while-revalidate=60';

/** Anonymous, read-only discovery API. */
export const publicRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onSend', async (request, reply) => {
    if (reply.statusCode !== 200 || reply.getHeader('cache-control')) return;
    // Personalised responses (a token was sent) must never land in a shared cache.
    reply.header('cache-control', request.auth ? 'private, no-store' : PUBLIC_CACHE);
  });

  app.get(
    '/treks',
    {
      config: { rateLimit: LIMITS.search },
      schema: {
        tags,
        summary: 'Search canonical treks; with from/to (IST dates) only treks with departures then',
        querystring: TrekSearchQuery,
        response: { 200: PublicTrekList, ...errors },
      },
    },
    async (request) => searchTreks(app.db, request.query),
  );

  app.get(
    '/treks/:slug',
    {
      schema: {
        tags,
        summary: 'Canonical trek page',
        params: SlugParams,
        response: { 200: PublicTrekDetail, ...errors },
      },
    },
    async (request) => getTrek(app.db, request.params.slug),
  );

  app.get(
    '/batches',
    {
      config: { rateLimit: LIMITS.search },
      schema: {
        tags,
        summary: 'Search departures across all treks (trek, district or organizer; dates)',
        querystring: BatchSearchQuery,
        response: { 200: PublicBatchList, ...errors },
      },
    },
    async (request) => searchBatches(app.db, request.query),
  );

  app.get(
    '/treks/:slug/batches',
    {
      schema: {
        tags,
        summary: 'Compare departures across approved organizers',
        params: SlugParams,
        querystring: PublicBatchQuery,
        response: { 200: PublicBatchList, ...errors },
      },
    },
    async (request) => trekBatches(app.db, request.params.slug, request.query),
  );

  app.get(
    '/organizers',
    {
      config: { rateLimit: LIMITS.search },
      schema: {
        tags,
        summary: 'Search approved organizers',
        querystring: OrganizerSearchQuery,
        response: { 200: PublicOrganizerList, ...errors },
      },
    },
    async (request) => searchOrganizers(app.db, request.query),
  );

  app.get(
    '/organizers/:slug',
    {
      schema: {
        tags,
        summary: 'Public organizer profile',
        params: SlugParams,
        response: { 200: PublicOrganizerDetail, ...errors },
      },
    },
    async (request) => getOrganizer(app.db, request.params.slug),
  );

  app.get(
    '/organizers/:slug/batches',
    {
      schema: {
        tags,
        summary: "An organizer's upcoming departures across all its treks",
        params: SlugParams,
        querystring: PublicBatchQuery,
        response: { 200: PublicBatchList, ...errors },
      },
    },
    async (request) => organizerBatches(app.db, request.params.slug, request.query),
  );

  app.get(
    '/batches/:id',
    {
      schema: {
        tags,
        summary: 'One departure: price, cutoff, seats, policy, pickups and organizer',
        params: IdParams,
        response: { 200: PublicBatch, ...errors },
      },
    },
    async (request) => getPublicBatch(app.db, request.params.id),
  );

  app.get(
    '/direct/:token',
    {
      schema: {
        tags,
        summary: 'Direct booking link landing (organizer-shared; not indexed)',
        params: TokenParams,
        response: { 200: DirectLinkLanding, ...errors },
      },
    },
    async (request, reply) => {
      const landing = await directLanding(app.db, request.params.token);
      // Utility page for one organizer's customers: keep it out of caches and search engines.
      return reply
        .header('cache-control', 'private, no-store')
        .header('x-robots-tag', 'noindex, nofollow')
        .send(landing);
    },
  );
};
