import { randomUUID } from 'node:crypto';
import { eq, inArray, like, or, sql } from 'drizzle-orm';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import {
  adminAuditLog,
  batches,
  bookings,
  idempotencyKeys,
  catalogTrekRequests,
  catalogTreks,
  organizerMembers,
  organizers,
  organizerTreks,
  outboxEvents,
  platformAdmins,
  users,
  type Database,
} from '@ohviana/db';
import type { OrganizerRole, OrganizerStatus } from '@ohviana/shared';
import { buildApp, type BuildAppOptions } from '../src/app';
import { createJwtVerifier } from '../src/auth/verifier';
import { loadConfig } from '../src/config';

try {
  process.loadEnvFile('../../.env');
} catch {
  // No .env (e.g. CI): rely on the environment.
}

export const TEST_ISSUER = 'https://test-project.supabase.co/auth/v1';

export function testConfig(overrides: Record<string, string> = {}) {
  const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL (or DATABASE_URL_TEST) to run API tests');
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    DATABASE_URL: url,
    DB_POOL_MAX: '2',
    SUPABASE_URL: 'https://test-project.supabase.co',
    // Suites fire many requests from one address; rate limiting has its own test.
    RATE_LIMIT_ENABLED: 'false',
    ...overrides,
  });
}

export interface TokenOptions {
  sub?: string;
  email?: string;
  fullName?: string;
  role?: string;
  audience?: string;
  issuer?: string;
  expiresIn?: string;
  isAnonymous?: boolean;
}

/** An ES256 key pair standing in for the Supabase project's signing key. */
export async function createTestKeys() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };
  const verifier = createJwtVerifier({
    keys: createLocalJWKSet({ keys: [jwk] }),
    issuer: TEST_ISSUER,
  });

  async function sign(o: TokenOptions = {}) {
    return new SignJWT({
      email: o.email ?? '',
      phone: '',
      role: o.role ?? 'authenticated',
      is_anonymous: o.isAnonymous ?? false,
      session_id: randomUUID(),
      user_metadata: o.fullName ? { full_name: o.fullName } : {},
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(o.sub ?? randomUUID())
      .setIssuer(o.issuer ?? TEST_ISSUER)
      .setAudience(o.audience ?? 'authenticated')
      .setIssuedAt()
      .setExpirationTime(o.expiresIn ?? '5m')
      .sign(privateKey);
  }

  return { verifier, sign };
}

export async function createTestApp(opts: BuildAppOptions = {}) {
  const app = await buildApp(testConfig(), opts);
  await app.ready();
  return app;
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/**
 * Creates users/organizers in the shared database and deletes them all in `cleanup()`.
 * API tests go through real HTTP handlers, so they cannot use rolled-back transactions.
 */
export function createFixtures(db: Database) {
  const userIds = new Set<string>();
  const organizerIds = new Set<string>();
  const tag = randomUUID().slice(0, 8);

  return {
    tag,
    /** Registers a user id for cleanup (e.g. one created implicitly by token sync). */
    trackUser(id: string) {
      userIds.add(id);
      return id;
    },
    /** Registers an organizer id for cleanup (e.g. one created through the API). */
    trackOrganizer(id: string) {
      organizerIds.add(id);
      return id;
    },
    /**
     * Inserts a confirmed booking directly and bumps the batch's sold seats, standing in for
     * the booking engine (Phase 7) where tests need sold seats.
     */
    async booking(batch: typeof batches.$inferSelect, quantity = 1) {
      await db
        .update(batches)
        .set({ confirmedSeats: sql`${batches.confirmedSeats} + ${quantity}` })
        .where(eq(batches.id, batch.id));
      const total = batch.pricePaise * quantity;
      const [row] = await db
        .insert(bookings)
        .values({
          bookingReference: `TST-${randomUUID().slice(0, 8).toUpperCase()}`,
          batchId: batch.id,
          organizerId: batch.organizerId,
          source: 'MARKETPLACE',
          quantity,
          unitPricePaise: batch.pricePaise,
          totalPaise: total,
          commissionRateBps: 0,
          commissionPaise: 0,
          commissionSnapshot: {
            basis: 'MARKETPLACE_AGREED_RATE',
            rateBps: 0,
            computedOnPaise: total,
          },
          policySnapshot: {
            trekTitle: 'Test',
            organizerName: 'Test',
            departureAt: batch.departureAt.toISOString(),
            returnAt: batch.returnAt.toISOString(),
            cancellationPolicy: null,
            inclusions: [],
            exclusions: [],
          },
          contactName: 'Test Customer',
          contactPhone: '+919999999999',
        })
        .returning();
      return row!;
    },
    async user(opts: { admin?: boolean; email?: string } = {}) {
      const id = randomUUID();
      userIds.add(id);
      await db.insert(users).values({ id, email: opts.email ?? `${id}@test.ohviana.dev` });
      if (opts.admin) await db.insert(platformAdmins).values({ userId: id });
      return id;
    },
    async organizer(opts: { status?: OrganizerStatus; name?: string } = {}) {
      const id = randomUUID();
      organizerIds.add(id);
      await db.insert(organizers).values({
        id,
        name: opts.name ?? `Test Org ${tag}`,
        slug: `test-org-${id.slice(0, 13)}`,
        status: opts.status ?? 'approved',
      });
      return id;
    },
    async member(organizerId: string, userId: string, role: OrganizerRole) {
      await db.insert(organizerMembers).values({ organizerId, userId, role });
    },
    /** Catalog trek whose slug contains the fixture tag (so cleanup can find it). */
    async catalogTrek(opts: { status?: 'draft' | 'published' | 'archived'; name?: string } = {}) {
      const [row] = await db
        .insert(catalogTreks)
        .values({
          name: opts.name ?? `Test Trek ${tag}`,
          slug: `test-trek-${tag}-${randomUUID().slice(0, 6)}`,
          status: opts.status ?? 'published',
        })
        .returning();
      return row!;
    },
    async catalogRequest(organizerId: string, requestedBy: string, name = `Requested Peak ${tag}`) {
      const [row] = await db
        .insert(catalogTrekRequests)
        .values({ organizerId, requestedBy, name })
        .returning();
      return row!;
    },
    /** Draft organizer trek waiting on a catalog request. */
    async draftTrekForRequest(organizerId: string, requestId: string) {
      const [row] = await db
        .insert(organizerTreks)
        .values({
          organizerId,
          catalogTrekRequestId: requestId,
          title: 'Waiting trek',
          slug: `waiting-${randomUUID().slice(0, 8)}`,
        })
        .returning();
      return row!;
    },
    /** An Idempotency-Key that cleanup can find. */
    idemKey() {
      return `${tag}-${randomUUID()}`;
    },
    /** Slug fragment that marks catalog treks for cleanup when created through the API. */
    slug(base: string) {
      return `${base}-${tag}`;
    },
    async cleanup() {
      const orgs = [...organizerIds];
      const people = [...userIds];
      if (people.length) {
        await db.delete(adminAuditLog).where(inArray(adminAuditLog.actorId, people));
      }
      if (orgs.length) {
        // Bookings and batches don't cascade from organizers (by design), so remove them first.
        await db.delete(bookings).where(inArray(bookings.organizerId, orgs));
        await db.delete(batches).where(inArray(batches.organizerId, orgs));
        await db
          .delete(outboxEvents)
          .where(inArray(sql`${outboxEvents.payload}->>'organizerId'`, orgs));
        await db.delete(organizers).where(inArray(organizers.id, orgs));
      }
      await db
        .delete(catalogTreks)
        .where(or(like(catalogTreks.slug, `%${tag}%`), like(catalogTreks.name, `%${tag}%`)));
      // Tests build Idempotency-Keys with the fixture tag (see `idemKey`).
      await db.delete(idempotencyKeys).where(like(idempotencyKeys.key, `${tag}-%`));
      if (people.length) await db.delete(users).where(inArray(users.id, people));
    },
  };
}
