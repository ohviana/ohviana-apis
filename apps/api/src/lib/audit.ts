import { adminAuditLog, outboxEvents, type Database, type Tx } from '@ohviana/db';

type Executor = Database | Tx;

export interface AuditInput {
  actorId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  payload?: Record<string, unknown>;
}

/** Records an admin action. Call inside the same transaction as the change it describes. */
export async function recordAdminAction(db: Executor, input: AuditInput): Promise<void> {
  await db.insert(adminAuditLog).values({
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    payload: input.payload ?? {},
  });
}

/** Queues a side effect (e.g. an email) for the outbox worker, atomically with the change. */
export async function enqueueEvent(
  db: Executor,
  topic: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(outboxEvents).values({ topic, payload });
}
