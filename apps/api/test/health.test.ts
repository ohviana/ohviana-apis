import { afterAll, describe, expect, it } from 'vitest';
import type { DbClient } from '@ohviana/db';
import { createTestApp } from './helpers';

describe('GET /v1/health/ready', () => {
  it('reports ok when the database is reachable', async () => {
    const app = await createTestApp();
    afterAll(() => app.close());

    const res = await app.inject({ method: 'GET', url: '/v1/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', checks: { database: { status: 'ok' } } });
  });

  it('reports 503 when the database is down', async () => {
    const broken: DbClient = {
      db: {} as DbClient['db'],
      ping: () => Promise.reject(new Error('connection refused')),
      close: async () => {},
    };
    const app = await createTestApp({ dbClient: broken });
    afterAll(() => app.close());

    const res = await app.inject({ method: 'GET', url: '/v1/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: 'unavailable',
      checks: { database: { status: 'error' } },
    });
  });
});
