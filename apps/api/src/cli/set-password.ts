import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, userCredentials, users } from '@ohviana/db';
import { hashPassword, PASSWORD_MIN } from '../auth/password';

/**
 * Sets (or resets) the email + password sign-in for an account, creating the account if needed.
 *   npm run user:set-password -- you@example.com            (generates a strong password)
 *   npm run user:set-password -- you@example.com 'MyPass123'
 */
const [rawEmail, given] = process.argv.slice(2);
const email = rawEmail?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run user:set-password -- <email> [password]');
  process.exit(1);
}
if (given !== undefined && given.length < PASSWORD_MIN) {
  console.error(`Password must be at least ${PASSWORD_MIN} characters`);
  process.exit(1);
}
const password = given ?? randomBytes(12).toString('base64url');

const { db, close } = createDb(process.env.DATABASE_URL ?? '', { max: 1 });
try {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`);
  const userId = existing?.id ?? randomUUID();
  if (!existing) await db.insert(users).values({ id: userId, email });
  const passwordHash = await hashPassword(password);
  await db
    .insert(userCredentials)
    .values({ userId, passwordHash })
    .onConflictDoUpdate({
      target: userCredentials.userId,
      set: { passwordHash, updatedAt: new Date() },
    });
  console.warn(`${existing ? 'Password set for existing account' : 'Account created'}: ${email}`);
  if (!given) console.warn(`Generated password (shown once): ${password}`);
} finally {
  await close();
}
