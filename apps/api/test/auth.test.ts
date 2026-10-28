import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '@ohviana/db';
import { createFixtures, createTestApp, createTestKeys, type TestApp } from './helpers';

let app: TestApp;
let keys: Awaited<ReturnType<typeof createTestKeys>>;
let fx: ReturnType<typeof createFixtures>;

beforeAll(async () => {
  keys = await createTestKeys();
  app = await createTestApp({
    verifier: keys.verifier,
    register: (a) => {
      a.get('/test/admin', { onRequest: a.guards.admin }, async () => ({ ok: true }));
      a.get(
        '/test/org/write',
        { onRequest: a.guards.organizer('batches:write') },
        async (req) => req.organizer,
      );
      a.get(
        '/test/org/read',
        { onRequest: a.guards.organizer('batches:read') },
        async (req) => req.organizer,
      );
      a.get(
        '/test/org/members',
        { onRequest: a.guards.organizer('org:manage_members') },
        async (req) => req.organizer,
      );
    },
  });
  fx = createFixtures(app.db);
});

afterAll(async () => {
  await fx.cleanup();
  await app.close();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function tokenFor(userId: string) {
  return keys.sign({ sub: userId });
}

describe('access token verification', () => {
  it('rejects /v1/me without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it.each([
    ['expired', { expiresIn: '-1m' }],
    ['wrong audience', { audience: 'anon' }],
    ['wrong issuer', { issuer: 'https://evil.example.com/auth/v1' }],
    ['non-authenticated role', { role: 'anon' }],
    ['anonymous user', { isAnonymous: true }],
  ])('rejects a token with %s', async (_label, opts) => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(await keys.sign(opts)),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token signed by a different key', async () => {
    const other = await createTestKeys();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(await other.sign()),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects malformed Authorization headers', async () => {
    for (const authorization of ['Token abc', 'Bearer', 'Bearer a b', 'Bearer not-a-jwt']) {
      const res = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization } });
      expect(res.statusCode, authorization).toBe(401);
    }
  });

  it('rejects an invalid token even on public routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health', headers: bearer('garbage') });
    expect(res.statusCode).toBe(401);
  });
});

describe('/v1/me', () => {
  it('creates the user row from token claims on first request', async () => {
    const id = fx.trackUser(randomUUID());
    const token = await keys.sign({
      sub: id,
      email: `Me-${id}@Test.Ohviana.dev`,
      fullName: 'Asha Rao',
    });

    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      user: { id, email: `me-${id}@test.ohviana.dev`, fullName: 'Asha Rao', phone: null },
      isAdmin: false,
      memberships: [],
    });
  });

  it('updates the profile and keeps edits over later token claims', async () => {
    const id = fx.trackUser(randomUUID());
    const token = await keys.sign({ sub: id, fullName: 'From Token' });

    const patched = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: bearer(token),
      payload: { fullName: 'Edited Name', phone: '+919876543210' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().user).toMatchObject({ fullName: 'Edited Name', phone: '+919876543210' });

    const [row] = await app.db.select().from(users).where(eq(users.id, id));
    expect(row?.fullName).toBe('Edited Name');
  });

  it('validates profile updates', async () => {
    const token = await keys.sign({ sub: fx.trackUser(randomUUID()) });
    for (const payload of [{}, { phone: '98765' }, { fullName: '' }]) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/me',
        headers: bearer(token),
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('lists memberships and admin status', async () => {
    const userId = await fx.user({ admin: true });
    const orgId = await fx.organizer({ name: `Membership Org ${fx.tag}` });
    await fx.member(orgId, userId, 'co_owner');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(await tokenFor(userId)),
    });
    expect(res.json()).toMatchObject({
      isAdmin: true,
      memberships: [{ organizerId: orgId, role: 'co_owner', status: 'approved' }],
    });
  });
});

describe('admin guard', () => {
  it('allows platform admins', async () => {
    const admin = await fx.user({ admin: true });
    const res = await app.inject({
      method: 'GET',
      url: '/test/admin',
      headers: bearer(await tokenFor(admin)),
    });
    expect(res.statusCode).toBe(200);
  });

  it('forbids everyone else', async () => {
    const user = await fx.user();
    const res = await app.inject({
      method: 'GET',
      url: '/test/admin',
      headers: bearer(await tokenFor(user)),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });
});

describe('organizer guard', () => {
  it('resolves the only membership without a header', async () => {
    const user = await fx.user();
    const org = await fx.organizer();
    await fx.member(org, user, 'owner');

    const res = await app.inject({
      method: 'GET',
      url: '/test/org/write',
      headers: bearer(await tokenFor(user)),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ organizerId: org, role: 'owner', status: 'approved' });
  });

  it('requires x-organizer-id when the user belongs to several organizers', async () => {
    const user = await fx.user();
    const [a, b] = [await fx.organizer(), await fx.organizer()];
    await fx.member(a, user, 'owner');
    await fx.member(b, user, 'trek_lead');
    const headers = bearer(await tokenFor(user));

    expect((await app.inject({ method: 'GET', url: '/test/org/read', headers })).statusCode).toBe(
      400,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/test/org/read',
      headers: { ...headers, 'x-organizer-id': b },
    });
    expect(res.json()).toMatchObject({ organizerId: b, role: 'trek_lead' });
  });

  it("blocks access to an organizer the user doesn't belong to (cross-tenant)", async () => {
    const user = await fx.user();
    const mine = await fx.organizer();
    const theirs = await fx.organizer();
    await fx.member(mine, user, 'owner');

    const res = await app.inject({
      method: 'GET',
      url: '/test/org/read',
      headers: { ...bearer(await tokenFor(user)), 'x-organizer-id': theirs },
    });
    expect(res.statusCode).toBe(403);
  });

  it('enforces role permissions', async () => {
    const user = await fx.user();
    const org = await fx.organizer();
    await fx.member(org, user, 'trek_lead');
    const headers = bearer(await tokenFor(user));

    expect((await app.inject({ method: 'GET', url: '/test/org/read', headers })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: 'GET', url: '/test/org/write', headers })).statusCode).toBe(
      403,
    );
  });

  it('keeps member management with owners and co-owners', async () => {
    const org = await fx.organizer();
    const status = async (role: 'co_owner' | 'trek_lead') => {
      const user = await fx.user();
      await fx.member(org, user, role);
      return (
        await app.inject({
          method: 'GET',
          url: '/test/org/members',
          headers: bearer(await tokenFor(user)),
        })
      ).statusCode;
    };
    expect(await status('co_owner')).toBe(200);
    expect(await status('trek_lead')).toBe(403);
  });

  it('makes suspended organizers read-only', async () => {
    const user = await fx.user();
    const org = await fx.organizer({ status: 'suspended' });
    await fx.member(org, user, 'owner');
    const headers = bearer(await tokenFor(user));

    expect((await app.inject({ method: 'GET', url: '/test/org/read', headers })).statusCode).toBe(
      200,
    );
    const write = await app.inject({ method: 'GET', url: '/test/org/write', headers });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.message).toContain('suspended');
  });

  it('forbids users with no organizer and rejects malformed header values', async () => {
    const user = await fx.user();
    const headers = bearer(await tokenFor(user));
    expect((await app.inject({ method: 'GET', url: '/test/org/read', headers })).statusCode).toBe(
      403,
    );
    const bad = await app.inject({
      method: 'GET',
      url: '/test/org/read',
      headers: { ...headers, 'x-organizer-id': 'not-a-uuid' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
