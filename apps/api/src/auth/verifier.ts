import {
  createRemoteJWKSet,
  decodeJwt,
  errors as joseErrors,
  jwtVerify,
  SignJWT,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { AppError } from '../lib/errors';

/** Verified identity extracted from a Supabase access token. */
export interface AuthClaims {
  userId: string;
  email: string | null;
  phone: string | null;
  /** True only for a phone-code sign-in: `phone` was proven by SMS, not typed into a profile. */
  phoneVerified?: boolean;
  fullName: string | null;
  sessionId: string | null;
  /**
   * Who issued the identity: Supabase (Google or an email code), the API (phone code) or the
   * dev login. Only a Supabase sign-in with a proven email may be linked to an existing account.
   */
  provider?: 'supabase' | 'ohviana' | 'dev';
  /** Supabase only: the email was proven by this sign-in (Google, or a code sent to it). */
  emailProven?: boolean;
}

/**
 * Supabase `amr` methods that prove the person controls the email: Google (oauth) and codes or
 * links sent to the inbox. A Supabase password sign-in proves nothing about the email.
 */
const EMAIL_PROVING_METHODS = new Set(['oauth', 'otp', 'magiclink', 'email/signup']);

export type TokenVerifier = (token: string) => Promise<AuthClaims>;

interface SupabasePayload extends JWTPayload {
  email?: string;
  phone?: string;
  role?: string;
  session_id?: string;
  is_anonymous?: boolean;
  user_metadata?: { full_name?: unknown; name?: unknown };
  amr?: { method?: unknown }[];
}

export interface JwtVerifierOptions {
  keys: JWTVerifyGetKey;
  issuer: string;
  audience?: string;
}

const blankToNull = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

/**
 * Verifies signature (asymmetric keys only), issuer, audience and expiry, then maps claims.
 * Every failure becomes a generic 401 so clients learn nothing about why a token was rejected.
 */
export function createJwtVerifier(opts: JwtVerifierOptions): TokenVerifier {
  return async (token) => {
    let payload: SupabasePayload;
    try {
      ({ payload } = await jwtVerify<SupabasePayload>(token, opts.keys, {
        issuer: opts.issuer,
        audience: opts.audience ?? 'authenticated',
        algorithms: ['ES256', 'RS256', 'EdDSA'],
        clockTolerance: 5,
      }));
    } catch (err) {
      if (err instanceof joseErrors.JOSEError) {
        throw new AppError('UNAUTHENTICATED', 'Invalid or expired access token');
      }
      throw err;
    }

    if (!payload.sub || payload.role !== 'authenticated' || payload.is_anonymous === true) {
      throw new AppError('UNAUTHENTICATED', 'Invalid or expired access token');
    }

    const meta = payload.user_metadata ?? {};
    return {
      userId: payload.sub,
      email: blankToNull(payload.email)?.toLowerCase() ?? null,
      phone: blankToNull(payload.phone),
      fullName: blankToNull(meta.full_name) ?? blankToNull(meta.name),
      sessionId: blankToNull(payload.session_id),
      provider: 'supabase',
      emailProven:
        Array.isArray(payload.amr) &&
        payload.amr.some(
          (m) => typeof m?.method === 'string' && EMAIL_PROVING_METHODS.has(m.method),
        ),
    };
  };
}

/** Production verifier: the project's published signing keys (cached and rotated by jose). */
export function createSupabaseVerifier(supabaseUrl: string): TokenVerifier {
  const base = supabaseUrl.replace(/\/+$/, '');
  return createJwtVerifier({
    keys: createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`), {
      cacheMaxAge: 10 * 60_000,
      cooldownDuration: 30_000,
    }),
    issuer: `${base}/auth/v1`,
  });
}

// ---------- Ohviana-issued tokens (phone-code sign-in) ----------

export const OHVIANA_ISSUER = 'ohviana';
const SESSION_TTL_SECONDS = 7 * 24 * 3600;

export interface IssuedToken {
  accessToken: string;
  expiresAt: string;
}

/** Signs a session token for a phone sign-in (HS256, our own issuer). */
export async function issueSessionToken(
  secret: string,
  user: { id: string; email: string | null; phone?: string | null },
  opts: { phoneVerified?: boolean } = {},
): Promise<IssuedToken> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const accessToken = await new SignJWT({
    role: 'authenticated',
    email: user.email ?? '',
    phone: user.phone ?? '',
    ...(opts.phoneVerified && user.phone ? { phone_verified: true } : {}),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(OHVIANA_ISSUER)
    .setAudience('authenticated')
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(secret));
  return { accessToken, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * Accepts our own HS256 session tokens and (optionally) Supabase tokens. The unverified `iss`
 * only picks which verifier runs; each verifier pins its own algorithms, so a token can't
 * switch verification method by changing its header.
 */
export function createCompositeVerifier(opts: {
  sessionSecret?: string | undefined;
  supabase: TokenVerifier;
}): TokenVerifier {
  const local = opts.sessionSecret
    ? createLocalSessionVerifier(new TextEncoder().encode(opts.sessionSecret))
    : null;
  return async (token) => {
    let issuer: string | undefined;
    try {
      issuer = decodeJwt(token).iss;
    } catch {
      throw new AppError('UNAUTHENTICATED', 'Invalid or expired access token');
    }
    if (issuer === OHVIANA_ISSUER) {
      if (!local) throw new AppError('UNAUTHENTICATED', 'Invalid or expired access token');
      return local(token);
    }
    return opts.supabase(token);
  };
}

function createLocalSessionVerifier(key: Uint8Array): TokenVerifier {
  return async (token) => {
    let payload: JWTPayload & {
      email?: string;
      phone?: string;
      phone_verified?: boolean;
      role?: string;
    };
    try {
      ({ payload } = await jwtVerify(token, key, {
        issuer: OHVIANA_ISSUER,
        audience: 'authenticated',
        algorithms: ['HS256'],
        clockTolerance: 5,
      }));
    } catch {
      throw new AppError('UNAUTHENTICATED', 'Invalid or expired access token');
    }
    if (!payload.sub || payload.role !== 'authenticated') {
      throw new AppError('UNAUTHENTICATED', 'Invalid or expired access token');
    }
    return {
      userId: payload.sub,
      email: blankToNull(payload.email)?.toLowerCase() ?? null,
      phone: blankToNull(payload.phone),
      phoneVerified: payload.phone_verified === true && !!blankToNull(payload.phone),
      fullName: null,
      sessionId: null,
      provider: 'ohviana',
    };
  };
}
