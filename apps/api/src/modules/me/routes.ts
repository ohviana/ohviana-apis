import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { organizerMembers, organizers, users, type Database } from '@ohviana/db';
import { ErrorResponse, MeResponse, UpdateMeRequest } from '@ohviana/contracts';
import { notFound } from '../../lib/errors';
import { requireAuth } from '../../plugins/auth';
import { isPlatformAdmin } from '../users/service';

async function loadMe(db: Database, userId: string): Promise<MeResponse> {
  const [user] = await db
    .select({ id: users.id, email: users.email, fullName: users.fullName, phone: users.phone })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) throw notFound('User');

  const [memberships, isAdmin] = await Promise.all([
    db
      .select({
        organizerId: organizers.id,
        name: organizers.name,
        slug: organizers.slug,
        status: organizers.status,
        logoUrl: organizers.logoUrl,
        role: organizerMembers.role,
      })
      .from(organizerMembers)
      .innerJoin(organizers, eq(organizers.id, organizerMembers.organizerId))
      .where(eq(organizerMembers.userId, userId))
      .orderBy(asc(organizers.name)),
    isPlatformAdmin(db, userId),
  ]);

  return { user, isAdmin, memberships };
}

export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  const security = [{ bearerAuth: [] }];

  app.get(
    '/me',
    {
      onRequest: app.guards.user,
      schema: {
        tags: ['me'],
        summary: 'Current user, admin flag and organizer memberships',
        security,
        response: { 200: MeResponse, 401: ErrorResponse },
      },
    },
    async (request) => loadMe(app.db, requireAuth(request).userId),
  );

  app.patch(
    '/me',
    {
      onRequest: app.guards.user,
      schema: {
        tags: ['me'],
        summary: 'Update own profile',
        security,
        body: UpdateMeRequest,
        response: { 200: MeResponse, 400: ErrorResponse, 401: ErrorResponse },
      },
    },
    async (request) => {
      const { userId } = requireAuth(request);
      await app.db
        .update(users)
        .set({
          ...(request.body.fullName !== undefined ? { fullName: request.body.fullName } : {}),
          ...(request.body.phone !== undefined ? { phone: request.body.phone } : {}),
        })
        .where(eq(users.id, userId));
      return loadMe(app.db, userId);
    },
  );
};
