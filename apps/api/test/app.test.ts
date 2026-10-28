import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/lib/errors';
import { createTestApp, type TestApp } from './helpers';

describe('api foundation', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/health returns ok with a request id header', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'ohviana-api' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('echoes a safe incoming request id and replaces unsafe ones', async () => {
    const safe = await app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { 'x-request-id': 'req-12345678' },
    });
    expect(safe.headers['x-request-id']).toBe('req-12345678');

    const unsafe = await app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { 'x-request-id': '<script>' },
    });
    expect(unsafe.headers['x-request-id']).not.toBe('<script>');
  });

  it('returns the standard envelope for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      error: { code: 'NOT_FOUND', requestId: expect.any(String) },
    });
  });
});

describe('error handler', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({
      register: (a) => {
        a.get('/boom/app', async () => {
          throw new AppError('SOLD_OUT', 'No seats left');
        });
        a.get('/boom/crash', async () => {
          throw new Error('secret internal detail');
        });
        a.post(
          '/boom/validate',
          { schema: { body: z.object({ quantity: z.number().int().positive() }) } },
          async () => ({ ok: true }),
        );
      },
    });
  });
  afterAll(async () => {
    await app.close();
  });

  it('maps AppError to its code and status', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom/app' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'SOLD_OUT', message: 'No seats left' });
  });

  it('hides internal error details', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom/crash' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(res.body).not.toContain('secret internal detail');
  });

  it('maps schema validation failures to VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/boom/validate',
      payload: { quantity: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().error.details.issues).toHaveLength(1);
  });
});

describe('CORS', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  // Regression: the plugin's default only allowed GET/HEAD/POST, so browsers blocked every edit.
  it.each(['PATCH', 'PUT', 'DELETE'])('lets the website send %s requests', async (method) => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/organizer/treks/x',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': method,
        'access-control-request-headers': 'content-type,authorization,x-organizer-id',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain(method);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('exposes the download file name and retry headers to the website', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { origin: 'http://localhost:3000' },
    });
    const exposed = String(res.headers['access-control-expose-headers']);
    for (const h of ['content-disposition', 'retry-after', 'x-request-id']) {
      expect(exposed).toContain(h);
    }
  });

  it('refuses other origins', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
