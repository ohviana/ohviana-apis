import { sql } from 'drizzle-orm';
import { createDb, requireDatabaseUrl } from '../client';
import { adminAuditLog, platformAdmins, users } from '../schema/index';

/**
 * Bootstrap or revoke platform admins:
 *   npm run admin:grant -- you@example.com
 *   npm run admin:grant -- you@example.com --revoke
 * The person must have signed in at least once (so their users row exists).
 */
const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith('--'))?.toLowerCase();
const revoke = args.includes('--revoke');

if (!email) {
  console.error('Usage: npm run admin:grant -- <email> [--revoke]');
  process.exit(1);
}

const { db, close } = createDb(requireDatabaseUrl(), { max: 1, applicationName: 'ohviana-admin' });
try {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`);
  if (!user) {
    console.error(`No user with email ${email}. Sign in to Ohviana once, then retry.`);
    process.exitCode = 1;
  } else if (revoke) {
    await db.transaction(async (tx) => {
      await tx.delete(platformAdmins).where(sql`${platformAdmins.userId} = ${user.id}`);
      await tx.insert(adminAuditLog).values({
        actorId: user.id,
        action: 'admin.revoked_via_cli',
        entityType: 'user',
        entityId: user.id,
      });
    });
    console.warn(`Revoked admin from ${email}`);
  } else {
    await db.transaction(async (tx) => {
      await tx.insert(platformAdmins).values({ userId: user.id }).onConflictDoNothing();
      await tx.insert(adminAuditLog).values({
        actorId: user.id,
        action: 'admin.granted_via_cli',
        entityType: 'user',
        entityId: user.id,
      });
    });
    console.warn(`Granted admin to ${email}`);
  }
} finally {
  await close();
}
