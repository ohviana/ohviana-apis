import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { organizerMembers, organizers, users } from '@ohviana/db';
import {
  roleHasPermission,
  statusAllowsPermission,
  type OrganizerRole,
  type OrganizerStatus,
  type OrgPermission,
} from '@ohviana/shared';
import type { AuthClaims, TokenVerifier } from '../auth/verifier';
import { AppError, forbidden } from '../lib/errors';
import {
  createUserSync,
  DEV_USER_HEADER,
  isPlatformAdmin,
  resolveDevUser,
} from '../modules/users/service';

export const ORGANIZER_HEADER = 'x-organizer-id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A route guard. Attach as `onRequest` so callers are authenticated/authorized before the body
 * is parsed or validated (unauthorized callers must not learn request schemas via 400s).
 */
export type Guard = (request: FastifyRequest) => Promise<void>;

export interface OrganizerContext {
  organizerId: string;
  role: OrganizerRole;
  status: OrganizerStatus;
  /** The member's mobile (E.164): a trek lead only sees batches that list it as a lead. */
  phone: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Verified caller identity, or null for anonymous requests. */
    auth: AuthClaims | null;
    /** Set by the `organizer(...)` guard. */
    organizer: OrganizerContext | null;
  }
  interface FastifyInstance {
    guards: {
      /** Requires a valid access token. */
      user: Guard;
      /** Requires a platform admin. */
      admin: Guard;
      /**
       * Requires membership of the active organizer with `permission`. The active organizer is
       * the `x-organizer-id` header, or the caller's only organizer when they belong to one.
       */
      organizer: (permission: OrgPermission) => Guard;
    };
  }
}

export interface AuthPluginOptions {
  verifier: TokenVerifier;
  /**
   * TEMPORARY (AUTH_MODE=dev): also accept `x-dev-user: <email>` without any token, so testing
   * doesn't depend on Supabase's email limits. Never enabled in production (see config).
   */
  devLogin?: boolean;
}

/** Returns the caller or throws 401. For use inside handlers behind `guards.user`. */
export function requireAuth(request: FastifyRequest): AuthClaims {
  if (!request.auth) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
  return request.auth;
}

/** For actions that need an extra permission only in some cases (e.g. "create and publish"). */
export function assertOrgPermission(ctx: OrganizerContext, permission: OrgPermission): void {
  if (!roleHasPermission(ctx.role, permission)) {
    throw forbidden(`Your role (${ctx.role}) cannot perform this action`);
  }
  if (!statusAllowsPermission(ctx.status, permission)) {
    throw forbidden(`This action is not available while the organizer is ${ctx.status}`);
  }
}

export function requireOrganizer(request: FastifyRequest): OrganizerContext {
  if (!request.organizer) throw new Error('organizer guard missing on this route');
  return request.organizer;
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, token, extra] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token || extra !== undefined) {
    throw new AppError('UNAUTHENTICATED', 'Authorization header must be "Bearer <token>"');
  }
  return token;
}

export default fp<AuthPluginOptions>(
  async (app, opts) => {
    const syncUser = createUserSync(app.db);

    app.decorateRequest('auth', null);
    app.decorateRequest('organizer', null);

    // Any request carrying a token must carry a valid one, even on public routes.
    app.addHook('onRequest', async (request) => {
      const devEmail = request.headers[DEV_USER_HEADER];
      if (opts.devLogin && typeof devEmail === 'string' && !request.headers.authorization) {
        const claims = await resolveDevUser(app.db, devEmail);
        await syncUser(claims);
        request.auth = claims;
        return;
      }
      const token = bearerToken(request);
      if (!token) return;
      const claims = await opts.verifier(token);
      await syncUser(claims);
      request.auth = claims;
    });

    const user: Guard = async (request) => {
      requireAuth(request);
    };

    const admin: Guard = async (request) => {
      const auth = requireAuth(request);
      if (!(await isPlatformAdmin(app.db, auth.userId))) {
        throw forbidden('Administrator access required');
      }
    };

    const organizer = (permission: OrgPermission): Guard =>
      async function organizerGuard(request) {
        const auth = requireAuth(request);
        const requested = request.headers[ORGANIZER_HEADER];
        if (
          requested !== undefined &&
          (typeof requested !== 'string' || !UUID_RE.test(requested))
        ) {
          throw new AppError('VALIDATION_ERROR', `${ORGANIZER_HEADER} must be a UUID`);
        }

        const memberships = await app.db
          .select({
            organizerId: organizerMembers.organizerId,
            role: organizerMembers.role,
            status: organizers.status,
            phone: users.phone,
          })
          .from(organizerMembers)
          .innerJoin(organizers, eq(organizers.id, organizerMembers.organizerId))
          .innerJoin(users, eq(users.id, organizerMembers.userId))
          .where(
            requested
              ? and(
                  eq(organizerMembers.userId, auth.userId),
                  eq(organizerMembers.organizerId, requested),
                )
              : eq(organizerMembers.userId, auth.userId),
          )
          .limit(2);

        if (memberships.length === 0) {
          throw forbidden(
            requested
              ? 'You are not a member of this organizer'
              : 'You are not a member of any organizer',
          );
        }
        if (memberships.length > 1) {
          throw new AppError(
            'VALIDATION_ERROR',
            `You belong to several organizers; send the ${ORGANIZER_HEADER} header`,
          );
        }

        const ctx = memberships[0]!;
        assertOrgPermission(ctx, permission);
        request.organizer = ctx;
      };

    app.decorate('guards', { user, admin, organizer });
  },
  { name: 'auth', dependencies: ['db'] },
);
