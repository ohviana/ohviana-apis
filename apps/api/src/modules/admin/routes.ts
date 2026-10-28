import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  AdminCatalogTrekListQuery,
  AdminOrganizer,
  AdminOrganizerList,
  AdminOrganizerListQuery,
  ApproveCatalogRequest,
  ApproveCatalogRequestResponse,
  ApproveOrganizerRequest,
  AuditList,
  AuditListQuery,
  CatalogRequest,
  CatalogRequestList,
  CatalogRequestListQuery,
  CatalogTrek,
  CatalogTrekList,
  CreateCatalogTrekRequest,
  ErrorResponse,
  IdParams,
  ReasonRequest,
  ReinstateOrganizerRequest,
  UpdateCatalogTrekRequest,
  UpdateCommissionRequest,
} from '@ohviana/contracts';
import { recordAdminAction } from '../../lib/audit';
import { requireAuth } from '../../plugins/auth';
import {
  changedFields,
  createCatalogTrek,
  getCatalogTrekRow,
  listCatalogTreks,
  toCatalogTrekDto,
  updateCatalogTrek,
} from '../catalog/service';
import { listAuditLog } from './audit.service';
import {
  approveCatalogRequest,
  listCatalogRequests,
  rejectCatalogRequest,
} from './catalog-requests.service';
import {
  getOrganizer,
  listOrganizers,
  reviewOrganizer,
  updateCommission,
} from './organizers.service';

const security = [{ bearerAuth: [] }];
const errors = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  409: ErrorResponse,
};

const CATALOG_AUDITED_FIELDS = [
  'name',
  'slug',
  'state',
  'region',
  'district',
  'difficulty',
  'summary',
  'maxAltitudeM',
  'heroImageUrl',
  'status',
] as const;

/** Everything under /v1/admin. The admin guard is applied to the whole scope. */
export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.guards.admin);

  // ---------- Catalog treks ----------

  app.get(
    '/catalog-treks',
    {
      schema: {
        tags: ['admin'],
        summary: 'List catalog treks (all statuses)',
        security,
        querystring: AdminCatalogTrekListQuery,
        response: { 200: CatalogTrekList, ...errors },
      },
    },
    async (request) => listCatalogTreks(app.db, request.query),
  );

  app.get(
    '/catalog-treks/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'Get a catalog trek',
        security,
        params: IdParams,
        response: { 200: CatalogTrek, ...errors },
      },
    },
    async (request) => toCatalogTrekDto(await getCatalogTrekRow(app.db, request.params.id)),
  );

  app.post(
    '/catalog-treks',
    {
      schema: {
        tags: ['admin'],
        summary: 'Create a catalog trek',
        security,
        body: CreateCatalogTrekRequest,
        response: { 201: CatalogTrek, ...errors },
      },
    },
    async (request, reply) => {
      const actorId = requireAuth(request).userId;
      const row = await app.db.transaction(async (tx) => {
        const created = await createCatalogTrek(tx, request.body);
        await recordAdminAction(tx, {
          actorId,
          action: 'catalog_trek.create',
          entityType: 'catalog_trek',
          entityId: created.id,
          payload: { name: created.name, slug: created.slug, status: created.status },
        });
        return created;
      });
      return reply.status(201).send(toCatalogTrekDto(row));
    },
  );

  app.patch(
    '/catalog-treks/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'Update a catalog trek (including publish/archive via status)',
        security,
        params: IdParams,
        body: UpdateCatalogTrekRequest,
        response: { 200: CatalogTrek, ...errors },
      },
    },
    async (request) => {
      const actorId = requireAuth(request).userId;
      const row = await app.db.transaction(async (tx) => {
        const { before, after } = await updateCatalogTrek(tx, request.params.id, request.body);
        await recordAdminAction(tx, {
          actorId,
          action: 'catalog_trek.update',
          entityType: 'catalog_trek',
          entityId: after.id,
          payload: { changes: changedFields(before, after, CATALOG_AUDITED_FIELDS) },
        });
        return after;
      });
      return toCatalogTrekDto(row);
    },
  );

  // ---------- Organizers ----------

  app.get(
    '/organizers',
    {
      schema: {
        tags: ['admin'],
        summary: 'List organizers, e.g. ?status=pending for the review queue',
        security,
        querystring: AdminOrganizerListQuery,
        response: { 200: AdminOrganizerList, ...errors },
      },
    },
    async (request) => listOrganizers(app.db, request.query),
  );

  app.get(
    '/organizers/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'Get an organizer including private contact and verification details',
        security,
        params: IdParams,
        response: { 200: AdminOrganizer, ...errors },
      },
    },
    async (request) => getOrganizer(app.db, request.params.id),
  );

  app.post(
    '/organizers/:id/approve',
    {
      schema: {
        tags: ['admin'],
        summary: 'Approve a pending or previously rejected organizer and set its commission',
        security,
        params: IdParams,
        body: ApproveOrganizerRequest,
        response: { 200: AdminOrganizer, ...errors },
      },
    },
    async (request) =>
      reviewOrganizer(app.db, {
        actorId: requireAuth(request).userId,
        organizerId: request.params.id,
        action: 'approve',
        note: request.body.note,
        commissionRateBps: request.body.commissionRateBps,
      }),
  );

  for (const action of ['reject', 'suspend'] as const) {
    app.post(
      `/organizers/:id/${action}`,
      {
        schema: {
          tags: ['admin'],
          summary:
            action === 'reject'
              ? 'Reject a pending organizer (note is shown to the organizer)'
              : 'Suspend an approved organizer (their batches stop accepting bookings)',
          security,
          params: IdParams,
          body: ReasonRequest,
          response: { 200: AdminOrganizer, ...errors },
        },
      },
      async (request) =>
        reviewOrganizer(app.db, {
          actorId: requireAuth(request).userId,
          organizerId: request.params.id,
          action,
          note: request.body.note,
        }),
    );
  }

  app.post(
    '/organizers/:id/reinstate',
    {
      schema: {
        tags: ['admin'],
        summary: 'Reinstate a suspended organizer',
        security,
        params: IdParams,
        body: ReinstateOrganizerRequest,
        response: { 200: AdminOrganizer, ...errors },
      },
    },
    async (request) =>
      reviewOrganizer(app.db, {
        actorId: requireAuth(request).userId,
        organizerId: request.params.id,
        action: 'reinstate',
        note: request.body.note,
      }),
  );

  app.put(
    '/organizers/:id/commission',
    {
      schema: {
        tags: ['admin'],
        summary: 'Change the agreed commission (applies to new bookings only)',
        security,
        params: IdParams,
        body: UpdateCommissionRequest,
        response: { 200: AdminOrganizer, ...errors },
      },
    },
    async (request) =>
      updateCommission(app.db, {
        actorId: requireAuth(request).userId,
        organizerId: request.params.id,
        ...request.body,
      }),
  );

  // ---------- Catalog requests ----------

  app.get(
    '/catalog-requests',
    {
      schema: {
        tags: ['admin'],
        summary: 'List organizer requests for new catalog treks',
        security,
        querystring: CatalogRequestListQuery,
        response: { 200: CatalogRequestList, ...errors },
      },
    },
    async (request) => listCatalogRequests(app.db, request.query),
  );

  app.post(
    '/catalog-requests/:id/approve',
    {
      schema: {
        tags: ['admin'],
        summary: 'Approve by linking an existing catalog trek or creating a new one',
        security,
        params: IdParams,
        body: ApproveCatalogRequest,
        response: { 200: ApproveCatalogRequestResponse, ...errors },
      },
    },
    async (request) =>
      approveCatalogRequest(app.db, requireAuth(request).userId, request.params.id, request.body),
  );

  app.post(
    '/catalog-requests/:id/reject',
    {
      schema: {
        tags: ['admin'],
        summary: 'Reject a catalog request (note is shown to the organizer)',
        security,
        params: IdParams,
        body: ReasonRequest,
        response: { 200: CatalogRequest, ...errors },
      },
    },
    async (request) =>
      rejectCatalogRequest(
        app.db,
        requireAuth(request).userId,
        request.params.id,
        request.body.note,
      ),
  );

  // ---------- Audit log ----------

  app.get(
    '/audit-log',
    {
      schema: {
        tags: ['admin'],
        summary: 'Admin actions, newest first',
        security,
        querystring: AuditListQuery,
        response: { 200: AuditList, ...errors },
      },
    },
    async (request) => listAuditLog(app.db, request.query),
  );
};
