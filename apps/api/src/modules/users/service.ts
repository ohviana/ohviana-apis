import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { pgConstraintName, platformAdmins, users, type Database } from '@ohviana/db';
import type { AuthClaims } from '../../auth/verifier';
import { AppError } from '../../lib/errors';

const SYNC_TTL_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 10_000;

/**
 * Keeps `public.users` in step with the identity in the access token. Writes only when the
 * claims changed or the cache entry expired, so most requests cost no database write.
 */
export function createUserSync(db: Database) {
  const seen = new Map<string, { fingerprint: string; at: number }>();

  return async function syncUser(claims: AuthClaims): Promise<void> {
    const fingerprint = `${claims.email}|${claims.phone}|${claims.fullName}`;
    const cached = seen.get(claims.userId);
    if (cached && cached.fingerprint === fingerprint && Date.now() - cached.at < SYNC_TTL_MS) {
      return;
    }

    const upsert = (email: string | null) =>
      db
        .insert(users)
        .values({ id: claims.userId, email, phone: claims.phone, fullName: claims.fullName })
        .onConflictDoUpdate({
          target: users.id,
          // Token claims fill in blanks but never overwrite edits made through PATCH /v1/me.
          set: {
            email: sql`coalesce(excluded.email, ${users.email})`,
            phone: sql`coalesce(${users.phone}, excluded.phone)`,
            fullName: sql`coalesce(${users.fullName}, excluded.full_name)`,
            updatedAt: new Date(),
          },
        });

    try {
      await upsert(claims.email);
    } catch (err) {
      // A stale row (e.g. a deleted-and-recreated auth user) still holds this email. Keep the
      // request working without the email rather than failing authentication.
      if (pgConstraintName(err) !== 'users_email_lower_uq') throw err;
      await upsert(null);
    }

    if (seen.size >= MAX_CACHE_ENTRIES) seen.clear();
    seen.set(claims.userId, { fingerprint, at: Date.now() });
  };
}

export async function isPlatformAdmin(db: Database, userId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: platformAdmins.userId })
    .from(platformAdmins)
    .where(eq(platformAdmins.userId, userId))
    .limit(1);
  return rows.length > 0;
}

// ---------- Dev-only login (AUTH_MODE=dev) ----------

export const DEV_USER_HEADER = 'x-dev-user';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Stable UUID for an email, so a dev identity is the same user every time. */
function devUserId(email: string): string {
  const h = createHash('sha1').update(`ohviana-dev-user:${email}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * TEMPORARY testing aid: trusts an email in the `x-dev-user` header instead of a Supabase token.
 * Reuses the existing account with that email (so admins stay admins), otherwise a stable id.
 * Only reachable when AUTH_MODE=dev, which the API refuses to start with in production.
 */
export async function resolveDevUser(db: Database, rawEmail: string): Promise<AuthClaims> {
  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    throw new AppError('UNAUTHENTICATED', `${DEV_USER_HEADER} must be an email address`);
  }
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  return {
    userId: existing?.id ?? devUserId(email),
    email,
    phone: null,
    fullName: null,
    sessionId: null,
  };
}
