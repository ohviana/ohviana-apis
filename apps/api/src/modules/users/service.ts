import { createHash } from 'node:crypto';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { pgConstraintName, platformAdmins, users, type Database } from '@ohviana/db';
import type { AuthClaims } from '../../auth/verifier';
import { AppError } from '../../lib/errors';

const SYNC_TTL_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 10_000;

/**
 * Keeps `public.users` in step with the identity in the access token and returns the claims
 * for the account the caller acts as. Writes only when the claims changed or the cache entry
 * expired, so most requests cost no database write.
 *
 * A Supabase sign-in (Google or an email code) for an email that already has an account (an
 * organizer who used email + password, say) acts as that account: it is linked through
 * `users.auth_user_id` on first use. Only proven emails link, so nobody can take over an
 * account by typing someone else's address.
 */
export function createUserSync(db: Database) {
  const seen = new Map<string, { fingerprint: string; at: number }>();
  const links = new Map<string, { userId: string; at: number }>();

  async function accountFor(claims: AuthClaims): Promise<string> {
    if (claims.provider !== 'supabase') return claims.userId;
    const sub = claims.userId;
    const cached = links.get(sub);
    if (cached && Date.now() - cached.at < SYNC_TTL_MS) return cached.userId;

    const remember = (userId: string) => {
      if (links.size >= MAX_CACHE_ENTRIES) links.clear();
      links.set(sub, { userId, at: Date.now() });
      return userId;
    };
    const known = async () =>
      (
        await db
          .select({ id: users.id })
          .from(users)
          .where(or(eq(users.id, sub), eq(users.authUserId, sub)))
          .limit(1)
      )[0]?.id;

    const existing = await known();
    if (existing) return remember(existing);
    if (!claims.email || !claims.emailProven) return sub;

    const [linked] = await db
      .update(users)
      .set({ authUserId: sub, updatedAt: new Date() })
      .where(and(sql`lower(${users.email}) = ${claims.email}`, isNull(users.authUserId)))
      .returning({ id: users.id });
    if (linked) return remember(linked.id);
    // A parallel request may have linked it a moment ago.
    return remember((await known()) ?? sub);
  }

  return async function syncUser(claims: AuthClaims): Promise<AuthClaims> {
    const resolved = { ...claims, userId: await accountFor(claims) };
    const fingerprint = `${resolved.email}|${resolved.phone}|${resolved.fullName}`;
    const cached = seen.get(resolved.userId);
    if (cached && cached.fingerprint === fingerprint && Date.now() - cached.at < SYNC_TTL_MS) {
      return resolved;
    }

    const upsert = (email: string | null) =>
      db
        .insert(users)
        .values({
          id: resolved.userId,
          email,
          phone: resolved.phone,
          fullName: resolved.fullName,
        })
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
      await upsert(resolved.email);
    } catch (err) {
      // A stale row (e.g. a deleted-and-recreated auth user) still holds this email. Keep the
      // request working without the email rather than failing authentication.
      if (pgConstraintName(err) !== 'users_email_lower_uq') throw err;
      await upsert(null);
    }

    if (seen.size >= MAX_CACHE_ENTRIES) seen.clear();
    seen.set(resolved.userId, { fingerprint, at: Date.now() });
    return resolved;
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
    provider: 'dev',
  };
}
