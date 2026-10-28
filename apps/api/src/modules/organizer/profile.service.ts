import { and, asc, count, eq, sql } from 'drizzle-orm';
import {
  media,
  organizerMembers,
  organizers,
  pgConstraintName,
  users,
  type Database,
} from '@ohviana/db';
import { processImage } from '../../lib/images';
import { mediaPaths } from '../media/service';
import type {
  AddMemberRequest,
  Member,
  OrganizerProfile,
  RegisterOrganizerRequest,
  UpdateOrganizerProfileRequest,
} from '@ohviana/contracts';
import { slugify } from '@ohviana/shared';
import { revokeLead } from './leads.service';
import { enqueueEvent } from '../../lib/audit';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors';

/** Guards against one account spawning organizers in bulk. */
export const MAX_OWNED_ORGANIZERS = 5;

type OrganizerRow = typeof organizers.$inferSelect;

export function toProfileDto(r: OrganizerRow): OrganizerProfile {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    status: r.status,
    tagline: r.tagline,
    description: r.description,
    logoUrl: r.logoUrl,
    city: r.city,
    contactEmail: r.contactEmail,
    contactPhone: r.contactPhone,
    gstin: r.gstin,
    commissionRateBps: r.commissionRateBps,
    reviewNote: r.reviewNote,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

function rethrowSlugConflict(err: unknown, slug: string): never {
  if (pgConstraintName(err) === 'organizers_slug_uq') {
    throw conflict(`The name "${slug}" is already taken; choose a different slug`);
  }
  throw err;
}

/** Creates a pending organizer with the caller as owner, and notifies admins. */
export async function registerOrganizer(
  db: Database,
  userId: string,
  input: RegisterOrganizerRequest,
): Promise<OrganizerProfile> {
  const slug = input.slug ?? slugify(input.name);
  if (slug.length < 2) throw badRequest('Could not derive a slug from the name; provide one');

  return db.transaction(async (tx) => {
    // Serialize registrations per user so the ownership cap can't be raced.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`register:${userId}`}))`);
    const [owned] = await tx
      .select({ n: count() })
      .from(organizerMembers)
      .where(and(eq(organizerMembers.userId, userId), eq(organizerMembers.role, 'owner')));
    if ((owned?.n ?? 0) >= MAX_OWNED_ORGANIZERS) {
      throw conflict(`You already own ${MAX_OWNED_ORGANIZERS} organizers`);
    }

    let row: OrganizerRow;
    try {
      [row] = (await tx
        .insert(organizers)
        .values({ ...input, slug, status: 'pending' })
        .returning()) as [OrganizerRow];
    } catch (err) {
      rethrowSlugConflict(err, slug);
    }
    await tx.insert(organizerMembers).values({ organizerId: row.id, userId, role: 'owner' });
    await enqueueEvent(tx, 'organizer.registered', {
      organizerId: row.id,
      name: row.name,
      registeredBy: userId,
    });
    return toProfileDto(row);
  });
}

/**
 * Stores an uploaded logo (resized and re-encoded like trek photos; metadata dropped) and
 * points the profile at it.
 */
export async function setUploadedLogo(
  db: Database,
  organizerId: string,
  file: Buffer,
): Promise<OrganizerProfile> {
  const image = await processImage(file);
  const [row] = await db.transaction(async (tx) => {
    const [stored] = await tx
      .insert(media)
      .values({
        organizerId,
        contentType: image.contentType,
        width: image.width,
        height: image.height,
        bytes: image.bytes,
        thumbBytes: image.thumbBytes,
        sizeBytes: image.bytes.length,
        sha256: image.sha256,
      })
      .returning({ id: media.id });
    return (
      tx
        .update(organizers)
        // The 480px variant is plenty for a logo shown at most ~60px.
        .set({ logoUrl: mediaPaths(stored!.id).thumbUrl })
        .where(eq(organizers.id, organizerId))
        .returning()
    );
  });
  if (!row) throw notFound('Organizer');
  return toProfileDto(row);
}

export async function getProfile(db: Database, organizerId: string): Promise<OrganizerProfile> {
  const [row] = await db.select().from(organizers).where(eq(organizers.id, organizerId));
  if (!row) throw notFound('Organizer');
  return toProfileDto(row);
}

export async function updateProfile(
  db: Database,
  organizerId: string,
  input: UpdateOrganizerProfileRequest,
): Promise<OrganizerProfile> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: organizers.status, slug: organizers.slug })
      .from(organizers)
      .where(eq(organizers.id, organizerId))
      .for('update');
    if (!current) throw notFound('Organizer');
    if (input.slug !== undefined && input.slug !== current.slug && current.status !== 'pending') {
      throw conflict('The slug can only be changed before approval');
    }
    try {
      const [row] = await tx
        .update(organizers)
        .set(input)
        .where(eq(organizers.id, organizerId))
        .returning();
      return toProfileDto(row!);
    } catch (err) {
      rethrowSlugConflict(err, input.slug ?? current.slug);
    }
  });
}

// ---------- Members ----------

export async function listMembers(db: Database, organizerId: string): Promise<Member[]> {
  const rows = await db
    .select({
      userId: organizerMembers.userId,
      email: users.email,
      phone: users.phone,
      fullName: users.fullName,
      role: organizerMembers.role,
      createdAt: organizerMembers.createdAt,
    })
    .from(organizerMembers)
    .innerJoin(users, eq(users.id, organizerMembers.userId))
    .where(eq(organizerMembers.organizerId, organizerId))
    .orderBy(
      sql`case ${organizerMembers.role} when 'owner' then 0 when 'co_owner' then 1 else 2 end`,
      asc(organizerMembers.createdAt),
    );
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/**
 * Adds a co-owner: an existing Ohviana account (they must have signed in once), found by email
 * or mobile. A trek lead of this organizer is promoted.
 */
export async function addMember(
  db: Database,
  organizerId: string,
  input: AddMemberRequest,
): Promise<Member[]> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      input.email ? sql`lower(${users.email}) = ${input.email}` : eq(users.phone, input.phone!),
    )
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (!user) {
    throw new AppError(
      'NOT_FOUND',
      `No Ohviana account uses that ${input.email ? 'email' : 'mobile number'}. Ask them to sign in once, then retry.`,
    );
  }
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ role: organizerMembers.role })
      .from(organizerMembers)
      .where(
        and(eq(organizerMembers.organizerId, organizerId), eq(organizerMembers.userId, user.id)),
      );
    if (existing && existing.role !== 'trek_lead') throw conflict('They are already an owner here');
    await tx
      .insert(organizerMembers)
      .values({ organizerId, userId: user.id, role: 'co_owner' })
      .onConflictDoUpdate({
        target: [organizerMembers.organizerId, organizerMembers.userId],
        set: { role: 'co_owner' },
      });
  });
  return listMembers(db, organizerId);
}

/**
 * Promotes a trek lead to co-owner, or removes a member. The owner never changes. Removing a
 * trek lead revokes their access (by mobile), so signing in again doesn't bring it back.
 */
export async function changeMember(
  db: Database,
  organizerId: string,
  actorId: string,
  targetUserId: string,
  change: { role: 'co_owner' } | 'remove',
): Promise<Member[]> {
  const [target] = await db
    .select({ role: organizerMembers.role, phone: users.phone })
    .from(organizerMembers)
    .innerJoin(users, eq(users.id, organizerMembers.userId))
    .where(
      and(eq(organizerMembers.organizerId, organizerId), eq(organizerMembers.userId, targetUserId)),
    );
  if (!target) throw notFound('Member');
  if (target.role === 'owner') throw forbidden("The owner can't be changed or removed");

  const where = and(
    eq(organizerMembers.organizerId, organizerId),
    eq(organizerMembers.userId, targetUserId),
  );
  if (change !== 'remove') {
    await db.update(organizerMembers).set({ role: change.role }).where(where);
  } else if (target.role === 'trek_lead' && target.phone) {
    await revokeLead(db, organizerId, target.phone, actorId);
  } else {
    await db.delete(organizerMembers).where(where);
  }
  return listMembers(db, organizerId);
}
