import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuditLog, organizerTreks, outboxEvents } from '@ohviana/db';
import { createFixtures, createTestApp, createTestKeys, type TestApp } from './helpers';

let app: TestApp;
let fx: ReturnType<typeof createFixtures>;
let adminHeaders: Record<string, string>;
let adminId: string;
let userHeaders: Record<string, string>;

beforeAll(async () => {
  const keys = await createTestKeys();
  app = await createTestApp({ verifier: keys.verifier });
  fx = createFixtures(app.db);
  adminId = await fx.user({ admin: true });
  adminHeaders = { authorization: `Bearer ${await keys.sign({ sub: adminId })}` };
  userHeaders = { authorization: `Bearer ${await keys.sign({ sub: await fx.user() })}` };
});

afterAll(async () => {
  await fx.cleanup();
  await app.close();
});

const auditFor = (entityId: string) =>
  app.db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, entityId));

describe('admin access', () => {
  it.each([
    ['GET', '/v1/admin/catalog-treks'],
    ['POST', '/v1/admin/catalog-treks'],
    ['GET', '/v1/admin/organizers'],
    ['POST', '/v1/admin/organizers/00000000-0000-4000-8000-000000000000/approve'],
    ['GET', '/v1/admin/catalog-requests'],
    ['GET', '/v1/admin/audit-log'],
  ] as const)('%s %s is forbidden for non-admins and requires sign-in', async (method, url) => {
    expect((await app.inject({ method, url, headers: userHeaders, payload: {} })).statusCode).toBe(
      403,
    );
    expect((await app.inject({ method, url, payload: {} })).statusCode).toBe(401);
  });
});

describe('catalog treks', () => {
  it('creates with a derived slug, defaults to draft, and audits', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/catalog-treks',
      headers: adminHeaders,
      payload: { name: `Brahmagiri ${fx.tag}`, district: 'Kodagu', difficulty: 'moderate' },
    });
    expect(res.statusCode).toBe(201);
    const trek = res.json();
    expect(trek).toMatchObject({
      slug: `brahmagiri-${fx.tag}`,
      status: 'draft',
      district: 'Kodagu',
    });

    const audit = await auditFor(trek.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'catalog_trek.create', actorId: adminId });
  });

  it('rejects a duplicate slug with 409', async () => {
    const payload = { name: 'Dup', slug: fx.slug('dup-peak') };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/catalog-treks',
          headers: adminHeaders,
          payload,
        })
      ).statusCode,
    ).toBe(201);
    const again = await app.inject({
      method: 'POST',
      url: '/v1/admin/catalog-treks',
      headers: adminHeaders,
      payload,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('STATE_CONFLICT');
  });

  it('validates input', async () => {
    for (const payload of [
      { name: 'x' },
      { name: 'Valid', slug: 'Not A Slug' },
      { name: 'Valid', difficulty: 'extreme' },
      { name: 'Valid', heroImageUrl: 'http://insecure.example.com/a.jpg' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/catalog-treks',
        headers: adminHeaders,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('updates, publishes and records only the changed fields', async () => {
    const trek = await fx.catalogTrek({ status: 'draft' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/catalog-treks/${trek.id}`,
      headers: adminHeaders,
      payload: { status: 'published', summary: 'Now live' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'published', summary: 'Now live' });

    const [entry] = await auditFor(trek.id);
    expect(entry?.payload).toEqual({
      changes: {
        status: { from: 'draft', to: 'published' },
        summary: { from: null, to: 'Now live' },
      },
    });
  });

  it('returns 404 for an unknown id', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/admin/catalog-treks/00000000-0000-4000-8000-000000000000',
      headers: adminHeaders,
      payload: { summary: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('searches by name and paginates without duplicates or gaps', async () => {
    for (let i = 0; i < 5; i++) await fx.catalogTrek({ name: `Paged ${fx.tag} ${i}` });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: URLSearchParams = new URLSearchParams({
        query: `Paged ${fx.tag}`,
        limit: '2',
        ...(cursor ? { cursor } : {}),
      });
      const res: { statusCode: number; json: () => unknown } = await app.inject({
        method: 'GET',
        url: `/v1/admin/catalog-treks?${qs}`,
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: { name: string }[]; nextCursor: string | null };
      seen.push(...body.items.map((t: { name: string }) => t.name));
      cursor = body.nextCursor;
    } while (cursor);

    expect(seen).toEqual([0, 1, 2, 3, 4].map((i) => `Paged ${fx.tag} ${i}`));
  });

  it('treats LIKE wildcards in search literally and rejects bad cursors', async () => {
    const wild = await app.inject({
      method: 'GET',
      url: '/v1/admin/catalog-treks?query=%25',
      headers: adminHeaders,
    });
    expect(wild.json().items).toEqual([]);
    const bad = await app.inject({
      method: 'GET',
      url: '/v1/admin/catalog-treks?cursor=nope',
      headers: adminHeaders,
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('organizer review', () => {
  const post = (id: string, action: string, payload: object) =>
    app.inject({
      method: 'POST',
      url: `/v1/admin/organizers/${id}/${action}`,
      headers: adminHeaders,
      payload,
    });

  it('approves a pending organizer with commission, audits and queues a notification', async () => {
    const org = await fx.organizer({ status: 'pending' });
    const res = await post(org, 'approve', { commissionRateBps: 750, note: 'Documents verified' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'approved',
      commissionRateBps: 750,
      reviewNote: 'Documents verified',
    });
    expect((await auditFor(org))[0]).toMatchObject({ action: 'organizer.approve' });
    const events = await app.db
      .select()
      .from(outboxEvents)
      .where(sql`${outboxEvents.payload}->>'organizerId' = ${org}`);
    expect(events.map((e) => e.topic)).toEqual(['organizer.approved']);
  });

  it('walks the full lifecycle: reject -> approve -> suspend -> reinstate', async () => {
    const org = await fx.organizer({ status: 'pending' });
    expect((await post(org, 'reject', { note: 'Missing permit' })).json().status).toBe('rejected');
    expect((await post(org, 'approve', { commissionRateBps: 500 })).json().status).toBe('approved');
    expect((await post(org, 'suspend', { note: 'Safety complaint' })).json().status).toBe(
      'suspended',
    );
    expect((await post(org, 'reinstate', {})).json().status).toBe('approved');

    const actions = (await auditFor(org)).map((a) => a.action).sort();
    expect(actions).toEqual(
      ['organizer.approve', 'organizer.reinstate', 'organizer.reject', 'organizer.suspend'].sort(),
    );
  });

  it.each([
    ['approved', 'approve', { commissionRateBps: 500 }],
    ['approved', 'reject', { note: 'Too late' }],
    ['pending', 'suspend', { note: 'Not yet approved' }],
    ['approved', 'reinstate', {}],
  ] as const)('refuses to %s -> %s with 409', async (status, action, payload) => {
    const org = await fx.organizer({ status });
    const res = await post(org, action, payload);
    expect(res.statusCode).toBe(409);
    expect(await auditFor(org)).toHaveLength(0);
  });

  it('requires a reason to reject or suspend', async () => {
    const org = await fx.organizer({ status: 'pending' });
    expect((await post(org, 'reject', {})).statusCode).toBe(400);
  });

  it('lets exactly one of two concurrent approvals win', async () => {
    const org = await fx.organizer({ status: 'pending' });
    const results = await Promise.all([
      post(org, 'approve', { commissionRateBps: 700 }),
      post(org, 'approve', { commissionRateBps: 800 }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await auditFor(org)).toHaveLength(1);
  });

  it('changes commission with an audited before/after', async () => {
    const org = await fx.organizer();
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/admin/organizers/${org}/commission`,
      headers: adminHeaders,
      payload: { commissionRateBps: 900, note: 'Renegotiated' },
    });
    expect(res.json().commissionRateBps).toBe(900);
    expect((await auditFor(org))[0]?.payload).toMatchObject({ from: 0, to: 900 });
  });

  it('lists the pending review queue with member counts', async () => {
    const org = await fx.organizer({ status: 'pending', name: `Queue Org ${fx.tag}` });
    await fx.member(org, await fx.user(), 'owner');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/organizers?status=pending&query=${encodeURIComponent(`Queue Org ${fx.tag}`)}`,
      headers: adminHeaders,
    });
    expect(res.json().items).toEqual([
      expect.objectContaining({ id: org, memberCount: 1, status: 'pending' }),
    ]);
  });
});

describe('catalog requests', () => {
  async function pendingRequestWithDraft() {
    const org = await fx.organizer();
    const requester = await fx.user();
    const request = await fx.catalogRequest(org, requester);
    const draft = await fx.draftTrekForRequest(org, request.id);
    return { org, request, draft };
  }

  const approve = (id: string, payload: object) =>
    app.inject({
      method: 'POST',
      url: `/v1/admin/catalog-requests/${id}/approve`,
      headers: adminHeaders,
      payload,
    });

  it('approves by linking an existing trek and attaches waiting drafts', async () => {
    const { request, draft } = await pendingRequestWithDraft();
    const trek = await fx.catalogTrek();

    const res = await approve(request.id, { catalogTrekId: trek.id });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      request: { status: 'approved', catalogTrekId: trek.id },
      linkedOrganizerTreks: 1,
    });
    const [linked] = await app.db
      .select()
      .from(organizerTreks)
      .where(eq(organizerTreks.id, draft.id));
    expect(linked?.catalogTrekId).toBe(trek.id);
  });

  it('approves by creating a new catalog trek', async () => {
    const { request } = await pendingRequestWithDraft();
    const res = await approve(request.id, {
      create: { name: `Created From Request ${fx.tag}`, status: 'published' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().request.catalogTrekId).toEqual(expect.any(String));
  });

  it('refuses to approve twice or to link an archived trek', async () => {
    const { request } = await pendingRequestWithDraft();
    const archived = await fx.catalogTrek({ status: 'archived' });
    expect((await approve(request.id, { catalogTrekId: archived.id })).statusCode).toBe(409);

    const trek = await fx.catalogTrek();
    expect((await approve(request.id, { catalogTrekId: trek.id })).statusCode).toBe(200);
    expect((await approve(request.id, { catalogTrekId: trek.id })).statusCode).toBe(409);
  });

  it('rolls back everything if creating the trek fails', async () => {
    const { request, draft } = await pendingRequestWithDraft();
    const existing = await fx.catalogTrek();
    const res = await approve(request.id, { create: { name: 'Clash', slug: existing.slug } });
    expect(res.statusCode).toBe(409);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/admin/catalog-requests?status=pending&limit=100',
      headers: adminHeaders,
    });
    expect(list.json().items.map((r: { id: string }) => r.id)).toContain(request.id);
    const [still] = await app.db
      .select()
      .from(organizerTreks)
      .where(eq(organizerTreks.id, draft.id));
    expect(still?.catalogTrekId).toBeNull();
  });

  it('rejects ambiguous approval bodies', async () => {
    const { request } = await pendingRequestWithDraft();
    const trek = await fx.catalogTrek();
    const res = await approve(request.id, { catalogTrekId: trek.id, create: { name: 'Both' } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects with a note', async () => {
    const { request } = await pendingRequestWithDraft();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/catalog-requests/${request.id}/reject`,
      headers: adminHeaders,
      payload: { note: 'Duplicate of Kudremukh' },
    });
    expect(res.json()).toMatchObject({ status: 'rejected', reviewNote: 'Duplicate of Kudremukh' });
  });
});

describe('audit log', () => {
  it('lists entries for an entity with the actor email', async () => {
    const org = await fx.organizer({ status: 'pending' });
    await app.inject({
      method: 'POST',
      url: `/v1/admin/organizers/${org}/approve`,
      headers: adminHeaders,
      payload: { commissionRateBps: 600 },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/audit-log?entityType=organizer&entityId=${org}`,
      headers: adminHeaders,
    });
    expect(res.json().items).toEqual([
      expect.objectContaining({
        action: 'organizer.approve',
        actorId: adminId,
        actorEmail: `${adminId}@test.ohviana.dev`,
      }),
    ]);
  });
});
