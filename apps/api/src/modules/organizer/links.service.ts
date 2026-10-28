import { randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { batches, directLinks, type Database } from '@ohviana/db';
import type { CreateDirectLinkRequest, DirectLink } from '@ohviana/contracts';
import { badRequest, conflict, notFound } from '../../lib/errors';

/** 32 URL-safe characters (192 bits): unguessable, so a link can't be enumerated. */
export function newDirectLinkToken(): string {
  return randomBytes(24).toString('base64url');
}

function toDto(r: typeof directLinks.$inferSelect): DirectLink {
  return {
    id: r.id,
    batchId: r.batchId,
    token: r.token,
    label: r.label,
    active: r.active,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function createDirectLink(
  db: Database,
  organizerId: string,
  userId: string,
  input: CreateDirectLinkRequest,
): Promise<DirectLink> {
  if (input.expiresAt && new Date(input.expiresAt) <= new Date()) {
    throw badRequest('expiresAt must be in the future');
  }
  if (input.batchId) {
    const [batch] = await db
      .select({ status: batches.status })
      .from(batches)
      .where(and(eq(batches.id, input.batchId), eq(batches.organizerId, organizerId)));
    if (!batch) throw notFound('Batch');
    if (batch.status === 'cancelled' || batch.status === 'completed') {
      throw conflict(`Can't share a ${batch.status} batch`);
    }
  }
  const [row] = await db
    .insert(directLinks)
    .values({
      organizerId,
      batchId: input.batchId ?? null,
      token: newDirectLinkToken(),
      label: input.label ?? null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      createdBy: userId,
    })
    .returning();
  return toDto(row!);
}

export async function listDirectLinks(db: Database, organizerId: string): Promise<DirectLink[]> {
  const rows = await db
    .select()
    .from(directLinks)
    .where(eq(directLinks.organizerId, organizerId))
    .orderBy(desc(directLinks.createdAt));
  return rows.map(toDto);
}

/** Deactivation is permanent; create a new link to share again. */
export async function deactivateDirectLink(
  db: Database,
  organizerId: string,
  linkId: string,
): Promise<DirectLink> {
  const [row] = await db
    .update(directLinks)
    .set({ active: false })
    .where(and(eq(directLinks.id, linkId), eq(directLinks.organizerId, organizerId)))
    .returning();
  if (!row) throw notFound('Direct link');
  return toDto(row);
}
