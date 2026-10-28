import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { adminAuditLog, users, type Database } from '@ohviana/db';
import type { AuditEntry, AuditListQuery } from '@ohviana/contracts';
import { decodeCursor, toPage } from '../../lib/pagination';

export async function listAuditLog(db: Database, q: AuditListQuery) {
  const filters: SQL[] = [];
  if (q.entityType) filters.push(eq(adminAuditLog.entityType, q.entityType));
  if (q.entityId) filters.push(eq(adminAuditLog.entityId, q.entityId));
  if (q.action) filters.push(eq(adminAuditLog.action, q.action));
  if (q.cursor) {
    const [createdAt, id] = decodeCursor(q.cursor, 2);
    filters.push(
      sql`(date_trunc('milliseconds', ${adminAuditLog.createdAt}), ${adminAuditLog.id}) < (${createdAt}::timestamptz, ${id}::uuid)`,
    );
  }

  const rows = await db
    .select({
      id: adminAuditLog.id,
      actorId: adminAuditLog.actorId,
      actorEmail: users.email,
      action: adminAuditLog.action,
      entityType: adminAuditLog.entityType,
      entityId: adminAuditLog.entityId,
      payload: adminAuditLog.payload,
      createdAt: adminAuditLog.createdAt,
    })
    .from(adminAuditLog)
    .leftJoin(users, eq(users.id, adminAuditLog.actorId))
    .where(and(...filters))
    .orderBy(
      desc(sql`date_trunc('milliseconds', ${adminAuditLog.createdAt})`),
      desc(adminAuditLog.id),
    )
    .limit(q.limit + 1);

  const page = toPage(rows, q.limit, (r) => [r.createdAt.toISOString(), r.id]);
  return {
    items: page.items.map((r): AuditEntry => ({ ...r, createdAt: r.createdAt.toISOString() })),
    nextCursor: page.nextCursor,
  };
}
