import { eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userCredentials } from '@ohviana/db';
import { buildApp } from '../src/app';
import { createFixtures, testConfig } from './helpers';

const SECRET = 'test-session-secret-0123456789abcdef-xyz';
let app: Awaited<ReturnType<typeof buildApp>>;
let fx: ReturnType<typeof createFixtures>;

beforeAll(async () => {
  app = await buildApp(testConfig({ AUTH_JWT_SECRET: SECRET }));
  await app.ready();
  fx = createFixtures(app.db);
});

afterAll(async () => {
  await fx.cleanup();
  await app.close();
});

const signUp = (payload: object) => app.inject({ method: 'POST', url: '/v1/auth/signup', payload });
const signIn = (payload: object) => app.inject({ method: 'POST', url: '/v1/auth/signin', payload });
const me = (token: string) =>
  app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });

describe('email + password accounts', () => {
  it('signs up, then the session token works across the API', async () => {
    const email = `pw-${fx.tag}@test.ohviana.dev`;
    const res = await signUp({
      email: email.toUpperCase(),
      password: 'correct horse battery',
      fullName: 'Asha Rao',
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    fx.trackUser(body.user.id);
    expect(body.user).toMatchObject({ email, fullName: 'Asha Rao' });
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    expect((await me(body.accessToken)).json()).toMatchObject({
      user: { email, fullName: 'Asha Rao' },
    });

    // Only a salted scrypt hash is stored.
    const [cred] = await app.db
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, body.user.id));
    expect(cred!.passwordHash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(cred!.passwordHash).not.toContain('correct horse');
  });

  it('signs in with the right password only, with one generic error', async () => {
    const email = `pw2-${fx.tag}@test.ohviana.dev`;
    fx.trackUser((await signUp({ email, password: 'right-password-1' })).json().user.id);

    const ok = await signIn({ email, password: 'right-password-1' });
    expect(ok.statusCode).toBe(200);
    expect((await me(ok.json().accessToken)).statusCode).toBe(200);

    const wrong = await signIn({ email, password: 'wrong-password' });
    const unknown = await signIn({
      email: `nobody-${fx.tag}@test.ohviana.dev`,
      password: 'whatever-123',
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
  });

  it('refuses duplicate sign-ups, including simultaneous ones', async () => {
    const email = `dup-${fx.tag}@test.ohviana.dev`;
    const results = await Promise.all(
      [1, 2, 3].map(() => signUp({ email, password: 'password-123' })),
    );
    const created = results.filter((r) => r.statusCode === 201);
    expect(created).toHaveLength(1);
    fx.trackUser(created[0]!.json().user.id);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(2);
  });

  it('never lets sign-up take over an existing account without a password', async () => {
    const email = `existing-${fx.tag}@test.ohviana.dev`;
    await fx.user({ email, admin: true });
    const res = await signUp({ email, password: 'attacker-password' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('admin');
  });

  it('enforces a minimum password length', async () => {
    expect(
      (await signUp({ email: `short-${fx.tag}@test.ohviana.dev`, password: 'short' })).statusCode,
    ).toBe(400);
  });

  it('rejects tokens signed with another secret, expired ones, or a forged algorithm', async () => {
    const forge = (secret: string, exp: string) =>
      new SignJWT({ role: 'authenticated' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('ohviana')
        .setAudience('authenticated')
        .setSubject(crypto.randomUUID())
        .setIssuedAt()
        .setExpirationTime(exp)
        .sign(new TextEncoder().encode(secret));
    expect((await me(await forge('another-secret-another-secret-123456', '1h'))).statusCode).toBe(
      401,
    );
    expect((await me(await forge(SECRET, '-1m'))).statusCode).toBe(401);
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(
      JSON.stringify({
        iss: 'ohviana',
        aud: 'authenticated',
        sub: crypto.randomUUID(),
        role: 'authenticated',
        exp: 9e9,
      }),
    ).toString('base64url')}.`;
    expect((await me(unsigned)).statusCode).toBe(401);
  });

  it('is switched off when no session secret is configured', async () => {
    const plain = await buildApp(testConfig());
    await plain.ready();
    const res = await plain.inject({
      method: 'POST',
      url: '/v1/auth/signin',
      payload: { email: 'a@b.co', password: 'x' },
    });
    expect(res.statusCode).toBe(404);
    await plain.close();
  });
});
