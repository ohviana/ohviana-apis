import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  AddMemberRequest,
  BulkCreateBatchesRequest,
  CancelBatchRequest,
  CatalogTrekList,
  CreateBatchRequest,
  CreateCatalogRequestRequest,
  CreateDirectLinkRequest,
  CreateOrganizerTrekRequest,
  CreatePickupPointRequest,
  DashboardSummary,
  DirectLink,
  DirectLinkList,
  ErrorResponse,
  IdParams,
  MemberList,
  MemberParams,
  OrganizerBatch,
  OrganizerBatchArray,
  OrganizerBatchList,
  OrganizerBatchListQuery,
  OrganizerCatalogQuery,
  OrganizerCatalogRequest,
  OrganizerCatalogRequestList,
  OrganizerProfile,
  OrganizerTrek,
  OrganizerTrekList,
  OrganizerTrekListQuery,
  PickupParams,
  PhotoParams,
  UpdateTrekPhotoRequest,
  RegisterOrganizerRequest,
  RepeatBatchRequest,
  SetBatchPickupsRequest,
  UpdateBatchRequest,
  UpdateMemberRequest,
  TrekLeadList,
  TrekLeadRequest,
  UpdateOrganizerProfileRequest,
  UpdateOrganizerTrekRequest,
  UpdatePickupPointRequest,
} from '@ohviana/contracts';
import { PHOTO_CATEGORIES } from '@ohviana/shared';
import { badRequest } from '../../lib/errors';
import { assertOrgPermission, requireAuth, requireOrganizer } from '../../plugins/auth';
import {
  assertBatchVisible,
  batchScope,
  listTrekLeads,
  restoreLead,
  revokeLead,
} from './leads.service';
import { addTrekPhoto, deleteTrekPhoto, updateTrekPhoto } from '../media/service';
import { LIMITS } from '../../plugins/rate-limit';
import { listCatalogTreks } from '../catalog/service';
import {
  bulkCreateBatches,
  cancelBatch,
  createBatch,
  dashboardSummary,
  deleteDraftBatch,
  getBatch,
  listBatches,
  publishBatch,
  repeatBatch,
  setBatchPickups,
  updateBatch,
} from './batches.service';
import { createDirectLink, deactivateDirectLink, listDirectLinks } from './links.service';
import {
  addMember,
  changeMember,
  getProfile,
  listMembers,
  registerOrganizer,
  setUploadedLogo,
  updateProfile,
} from './profile.service';
import {
  addPickup,
  createCatalogRequest,
  createTrek,
  deletePickup,
  getTrek,
  getTrekRow,
  listCatalogRequests,
  listTreks,
  updatePickup,
  updateTrek,
} from './treks.service';

const security = [{ bearerAuth: [] }];
const errors = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  409: ErrorResponse,
};
const tags = ['organizer'];
const PhotoCategoryInput = z.enum(PHOTO_CATEGORIES);

/** POST /v1/organizers: any signed-in user can register an organization. */
export const organizerRegistrationRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/organizers',
    {
      config: { rateLimit: LIMITS.registration },
      onRequest: app.guards.user,
      schema: {
        tags,
        summary: 'Register an organization (starts pending; you become its owner)',
        security,
        body: RegisterOrganizerRequest,
        response: { 201: OrganizerProfile, ...errors },
      },
    },
    async (request, reply) => {
      const profile = await registerOrganizer(app.db, requireAuth(request).userId, request.body);
      return reply.status(201).send(profile);
    },
  );
};

/**
 * Everything under /v1/organizer acts on the caller's active organizer (see the organizer
 * guard): `x-organizer-id`, or their only membership.
 */
export const organizerRoutes: FastifyPluginAsyncZod = async (app) => {
  const g = app.guards.organizer;
  const org = (request: Parameters<typeof requireOrganizer>[0]) =>
    requireOrganizer(request).organizerId;

  // ---------- Profile ----------

  app.get(
    '/profile',
    {
      onRequest: g('org:read'),
      schema: {
        tags,
        summary: 'Organization profile and review status',
        security,
        response: { 200: OrganizerProfile, ...errors },
      },
    },
    async (request) => getProfile(app.db, org(request)),
  );

  app.patch(
    '/profile',
    {
      onRequest: g('org:edit_profile'),
      schema: {
        tags,
        summary: 'Update profile (slug only before approval)',
        security,
        body: UpdateOrganizerProfileRequest,
        response: { 200: OrganizerProfile, ...errors },
      },
    },
    async (request) => updateProfile(app.db, org(request), request.body),
  );

  app.post(
    '/profile/logo',
    {
      onRequest: g('org:edit_profile'),
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
      schema: {
        tags,
        summary: 'Upload a logo (multipart field `file`; JPEG/PNG/WebP ≤ 10 MB)',
        security,
        consumes: ['multipart/form-data'],
        response: { 200: OrganizerProfile, ...errors },
      },
    },
    async (request) => {
      let file: Buffer;
      try {
        const part = await request.file();
        if (!part) throw badRequest('Attach a logo image');
        file = await part.toBuffer();
      } catch (err) {
        if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          throw badRequest('That image is larger than 10 MB');
        }
        if ((err as { code?: string }).code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
          throw badRequest('Send the logo as multipart/form-data');
        }
        throw err;
      }
      return setUploadedLogo(app.db, org(request), file);
    },
  );

  app.get(
    '/dashboard/summary',
    {
      onRequest: g('org:read'),
      schema: {
        tags,
        summary: 'Batch counts per view and booking totals',
        security,
        response: { 200: DashboardSummary, ...errors },
      },
    },
    async (request) => dashboardSummary(app.db, org(request)),
  );

  // ---------- Members ----------

  app.get(
    '/members',
    {
      onRequest: g('org:read'),
      schema: { tags, summary: 'Team members', security, response: { 200: MemberList, ...errors } },
    },
    async (request) => ({ items: await listMembers(app.db, org(request)) }),
  );

  app.post(
    '/members',
    {
      onRequest: g('org:manage_members'),
      schema: {
        tags,
        summary: 'Add someone who has signed in to Ohviana at least once',
        security,
        body: AddMemberRequest,
        response: { 201: MemberList, ...errors },
      },
    },
    async (request, reply) =>
      reply.status(201).send({ items: await addMember(app.db, org(request), request.body) }),
  );

  app.patch(
    '/members/:userId',
    {
      onRequest: g('org:manage_members'),
      schema: {
        tags,
        summary: 'Promote a trek lead to co-owner (the owner never changes)',
        security,
        params: MemberParams,
        body: UpdateMemberRequest,
        response: { 200: MemberList, ...errors },
      },
    },
    async (request) => ({
      items: await changeMember(
        app.db,
        org(request),
        requireAuth(request).userId,
        request.params.userId,
        { role: request.body.role },
      ),
    }),
  );

  app.delete(
    '/members/:userId',
    {
      onRequest: g('org:manage_members'),
      schema: {
        tags,
        summary: 'Remove a co-owner, or revoke a trek lead (the owner never changes)',
        security,
        params: MemberParams,
        response: { 200: MemberList, ...errors },
      },
    },
    async (request) => ({
      items: await changeMember(
        app.db,
        org(request),
        requireAuth(request).userId,
        request.params.userId,
        'remove',
      ),
    }),
  );

  // ---------- Trek leads (named on batches by mobile) ----------

  app.get(
    '/trek-leads',
    {
      onRequest: g('org:manage_members'),
      schema: {
        tags,
        summary: 'Everyone named as a lead on your batches, with their access',
        security,
        response: { 200: TrekLeadList, ...errors },
      },
    },
    async (request) => ({ items: await listTrekLeads(app.db, org(request)) }),
  );

  app.post(
    '/trek-leads/revoke',
    {
      onRequest: g('org:manage_members'),
      schema: {
        tags,
        summary: "Take a trek lead's access away (stays away after they sign in again)",
        security,
        body: TrekLeadRequest,
        response: { 200: TrekLeadList, ...errors },
      },
    },
    async (request) => {
      await revokeLead(app.db, org(request), request.body.phone, requireAuth(request).userId);
      return { items: await listTrekLeads(app.db, org(request)) };
    },
  );

  app.post(
    '/trek-leads/restore',
    {
      onRequest: g('org:manage_members'),
      schema: {
        tags,
        summary: "Give a revoked trek lead's access back",
        security,
        body: TrekLeadRequest,
        response: { 200: TrekLeadList, ...errors },
      },
    },
    async (request) => {
      await restoreLead(app.db, org(request), request.body.phone);
      return { items: await listTrekLeads(app.db, org(request)) };
    },
  );

  // ---------- Catalog ----------

  app.get(
    '/catalog-treks',
    {
      onRequest: g('org:read'),
      schema: {
        tags,
        summary: 'Search published catalog treks to link a template to',
        security,
        querystring: OrganizerCatalogQuery,
        response: { 200: CatalogTrekList, ...errors },
      },
    },
    async (request) => listCatalogTreks(app.db, { ...request.query, status: 'published' }),
  );

  app.get(
    '/catalog-requests',
    {
      onRequest: g('org:read'),
      schema: {
        tags,
        summary: 'Your requests for new catalog treks',
        security,
        response: { 200: OrganizerCatalogRequestList, ...errors },
      },
    },
    async (request) => ({ items: await listCatalogRequests(app.db, org(request)) }),
  );

  app.post(
    '/catalog-requests',
    {
      onRequest: g('treks:write'),
      schema: {
        tags,
        summary: 'Ask admins to add a missing catalog trek',
        security,
        body: CreateCatalogRequestRequest,
        response: { 201: OrganizerCatalogRequest, ...errors },
      },
    },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          await createCatalogRequest(
            app.db,
            org(request),
            requireAuth(request).userId,
            request.body,
          ),
        ),
  );

  // ---------- Trek templates & pickups ----------

  app.get(
    '/treks',
    {
      onRequest: g('org:read'),
      schema: {
        tags,
        summary: 'Trek templates',
        security,
        querystring: OrganizerTrekListQuery,
        response: { 200: OrganizerTrekList, ...errors },
      },
    },
    async (request) => ({ items: await listTreks(app.db, org(request), request.query.status) }),
  );

  app.post(
    '/treks',
    {
      onRequest: g('treks:write'),
      schema: {
        tags,
        summary:
          'Create a trek (live as soon as it has a destination); optional pickups and first batch',
        security,
        body: CreateOrganizerTrekRequest,
        response: { 201: OrganizerTrek, ...errors },
      },
    },
    async (request, reply) => {
      if (request.body.publish) assertOrgPermission(requireOrganizer(request), 'batches:publish');
      return reply.status(201).send(await createTrek(app.db, org(request), request.body));
    },
  );

  app.get(
    '/treks/:id',
    {
      onRequest: g('org:read'),
      schema: {
        tags,
        summary: 'Get a trek template',
        security,
        params: IdParams,
        response: { 200: OrganizerTrek, ...errors },
      },
    },
    async (request) => getTrek(app.db, org(request), request.params.id),
  );

  app.patch(
    '/treks/:id',
    {
      onRequest: g('treks:write'),
      schema: {
        tags,
        summary: 'Update a trek (archive or restore via status)',
        security,
        params: IdParams,
        body: UpdateOrganizerTrekRequest,
        response: { 200: OrganizerTrek, ...errors },
      },
    },
    async (request) => updateTrek(app.db, org(request), request.params.id, request.body),
  );

  app.post(
    '/treks/:id/pickups',
    {
      onRequest: g('treks:write'),
      schema: {
        tags,
        summary: 'Add a pickup point',
        security,
        params: IdParams,
        body: CreatePickupPointRequest,
        response: { 201: OrganizerTrek, ...errors },
      },
    },
    async (request, reply) =>
      reply
        .status(201)
        .send(await addPickup(app.db, org(request), request.params.id, request.body)),
  );

  app.patch(
    '/treks/:id/pickups/:pickupId',
    {
      onRequest: g('treks:write'),
      schema: {
        tags,
        summary: 'Update a pickup point',
        security,
        params: PickupParams,
        body: UpdatePickupPointRequest,
        response: { 200: OrganizerTrek, ...errors },
      },
    },
    async (request) =>
      updatePickup(app.db, org(request), request.params.id, request.params.pickupId, request.body),
  );

  app.delete(
    '/treks/:id/pickups/:pickupId',
    {
      onRequest: g('treks:write'),
      schema: {
        tags,
        summary: 'Remove a pickup point (not if customers chose it)',
        security,
        params: PickupParams,
        response: { 200: OrganizerTrek, ...errors },
      },
    },
    async (request) =>
      deletePickup(app.db, org(request), request.params.id, request.params.pickupId),
  );

  // ---------- Trek photos ----------

  app.post(
    '/treks/:id/photos',
    {
      onRequest: g('treks:write'),
      config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
      schema: {
        tags,
        summary:
          'Upload a photo (multipart: fields `category`, `caption`, then `file`; JPEG/PNG/WebP ≤ 10 MB)',
        security,
        params: IdParams,
        consumes: ['multipart/form-data'],
        response: { 201: OrganizerTrek, ...errors },
      },
    },
    async (request, reply) => {
      const organizerId = org(request);
      await getTrekRow(app.db, organizerId, request.params.id);

      let file: Buffer;
      let fields: Record<string, unknown> = {};
      try {
        const part = await request.file();
        if (!part) throw badRequest('Attach a photo file');
        file = await part.toBuffer();
        fields = part.fields as Record<string, unknown>;
      } catch (err) {
        if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          throw badRequest('That photo is larger than 10 MB');
        }
        if ((err as { code?: string }).code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
          throw badRequest('Send the photo as multipart/form-data');
        }
        throw err;
      }
      const field = (name: string) => {
        const v = fields[name] as { value?: unknown } | undefined;
        return typeof v?.value === 'string' ? v.value.trim() : undefined;
      };
      const category = PhotoCategoryInput.safeParse(field('category') ?? 'destination');
      if (!category.success) throw badRequest('Unknown photo category');
      const caption = field('caption')?.slice(0, 200) || null;

      await addTrekPhoto(app.db, {
        organizerId,
        trekId: request.params.id,
        file,
        category: category.data,
        caption,
      });
      return reply.status(201).send(await getTrek(app.db, organizerId, request.params.id));
    },
  );

  app.patch(
    '/treks/:id/photos/:photoId',
    {
      onRequest: g('treks:write'),
      schema: {
        tags,
        summary: 'Change a photo’s category, caption or position',
        security,
        params: PhotoParams,
        body: UpdateTrekPhotoRequest,
        response: { 200: OrganizerTrek, ...errors },
      },
    },
    async (request) => {
      const organizerId = org(request);
      await updateTrekPhoto(
        app.db,
        organizerId,
        request.params.id,
        request.params.photoId,
        request.body,
      );
      return getTrek(app.db, organizerId, request.params.id);
    },
  );

  app.delete(
    '/treks/:id/photos/:photoId',
    {
      onRequest: g('treks:write'),
      schema: {
        tags,
        summary: 'Delete a photo',
        security,
        params: PhotoParams,
        response: { 200: OrganizerTrek, ...errors },
      },
    },
    async (request) => {
      const organizerId = org(request);
      await deleteTrekPhoto(app.db, organizerId, request.params.id, request.params.photoId);
      return getTrek(app.db, organizerId, request.params.id);
    },
  );

  // ---------- Batches ----------

  app.post(
    '/treks/:id/batches',
    {
      onRequest: g('batches:write'),
      schema: {
        tags,
        summary: 'Create a draft batch',
        security,
        params: IdParams,
        body: CreateBatchRequest,
        response: { 201: OrganizerBatch, ...errors },
      },
    },
    async (request, reply) =>
      reply
        .status(201)
        .send(await createBatch(app.db, org(request), request.params.id, request.body)),
  );

  app.post(
    '/treks/:id/batches/bulk',
    {
      onRequest: g('batches:write'),
      schema: {
        tags,
        summary:
          'Create many batches at once (all-or-nothing), e.g. weekly departures; drafts unless publish',
        security,
        params: IdParams,
        body: BulkCreateBatchesRequest,
        response: { 201: OrganizerBatchArray, ...errors },
      },
    },
    async (request, reply) => {
      if (request.body.publish) assertOrgPermission(requireOrganizer(request), 'batches:publish');
      return reply.status(201).send({
        items: await bulkCreateBatches(app.db, org(request), request.params.id, request.body),
      });
    },
  );

  app.get(
    '/batches',
    {
      onRequest: g('batches:read'),
      schema: {
        tags,
        summary: 'Batches, filterable by dashboard view (draft, upcoming, ongoing, sold_out, ...)',
        security,
        querystring: OrganizerBatchListQuery,
        response: { 200: OrganizerBatchList, ...errors },
      },
    },
    async (request) =>
      listBatches(app.db, org(request), request.query, batchScope(requireOrganizer(request))),
  );

  app.get(
    '/batches/:id',
    {
      onRequest: g('batches:read'),
      schema: {
        tags,
        summary: 'Get a batch (trek leads: only batches they lead)',
        security,
        params: IdParams,
        response: { 200: OrganizerBatch, ...errors },
      },
    },
    async (request) => {
      await assertBatchVisible(app.db, requireOrganizer(request), request.params.id);
      return getBatch(app.db, org(request), request.params.id);
    },
  );

  app.patch(
    '/batches/:id',
    {
      onRequest: g('batches:write'),
      schema: {
        tags,
        summary: 'Edit a batch (dates locked once seats are sold)',
        security,
        params: IdParams,
        body: UpdateBatchRequest,
        response: { 200: OrganizerBatch, ...errors },
      },
    },
    async (request) => updateBatch(app.db, org(request), request.params.id, request.body),
  );

  app.put(
    '/batches/:id/pickups',
    {
      onRequest: g('batches:write'),
      schema: {
        tags,
        summary: "Replace the batch's pickup points and times",
        security,
        params: IdParams,
        body: SetBatchPickupsRequest,
        response: { 200: OrganizerBatch, ...errors },
      },
    },
    async (request) =>
      setBatchPickups(app.db, org(request), request.params.id, request.body.pickups),
  );

  app.post(
    '/batches/:id/publish',
    {
      onRequest: g('batches:publish'),
      schema: {
        tags,
        summary: 'Make a draft batch bookable (organizer must be approved)',
        security,
        params: IdParams,
        response: { 200: OrganizerBatch, ...errors },
      },
    },
    async (request) => publishBatch(app.db, org(request), request.params.id),
  );

  app.post(
    '/batches/:id/repeat',
    {
      onRequest: g('batches:write'),
      schema: {
        tags,
        summary: 'Run a batch again on new dates (same price, seats and pickups)',
        security,
        params: IdParams,
        body: RepeatBatchRequest,
        response: { 201: OrganizerBatch, ...errors },
      },
    },
    async (request, reply) => {
      if (request.body.publish) assertOrgPermission(requireOrganizer(request), 'batches:publish');
      return reply
        .status(201)
        .send(await repeatBatch(app.db, org(request), request.params.id, request.body));
    },
  );

  app.post(
    '/batches/:id/cancel',
    {
      onRequest: g('batches:write'),
      schema: {
        tags,
        summary: 'Cancel a published batch and all its bookings (customers are notified)',
        security,
        params: IdParams,
        body: CancelBatchRequest,
        response: { 200: OrganizerBatch, ...errors },
      },
    },
    async (request) =>
      cancelBatch(
        app.db,
        org(request),
        requireAuth(request).userId,
        request.params.id,
        request.body.reason,
      ),
  );

  app.delete(
    '/batches/:id',
    {
      onRequest: g('batches:write'),
      schema: {
        tags,
        summary: 'Delete a draft batch',
        security,
        params: IdParams,
        response: { 204: z.null(), ...errors },
      },
    },
    async (request, reply) => {
      await deleteDraftBatch(app.db, org(request), request.params.id);
      return reply.status(204).send(null);
    },
  );

  // ---------- Direct links ----------

  app.get(
    '/direct-links',
    {
      onRequest: g('org:read'),
      schema: {
        tags,
        summary: 'Shareable direct booking links',
        security,
        response: { 200: DirectLinkList, ...errors },
      },
    },
    async (request) => ({ items: await listDirectLinks(app.db, org(request)) }),
  );

  app.post(
    '/direct-links',
    {
      onRequest: g('links:write'),
      schema: {
        tags,
        summary: 'Create a direct link (0% marketplace commission) for one batch or all batches',
        security,
        body: CreateDirectLinkRequest,
        response: { 201: DirectLink, ...errors },
      },
    },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          await createDirectLink(app.db, org(request), requireAuth(request).userId, request.body),
        ),
  );

  app.post(
    '/direct-links/:id/deactivate',
    {
      onRequest: g('links:write'),
      schema: {
        tags,
        summary: 'Permanently deactivate a direct link',
        security,
        params: IdParams,
        response: { 200: DirectLink, ...errors },
      },
    },
    async (request) => deactivateDirectLink(app.db, org(request), request.params.id),
  );
};
