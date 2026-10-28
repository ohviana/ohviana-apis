import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batches, organizerTreks } from '@ohviana/db';
import { createFixtures, createTestApp, createTestKeys, type TestApp } from './helpers';

let app: TestApp;
let fx: ReturnType<typeof createFixtures>;
let keys: Awaited<ReturnType<typeof createTestKeys>>;

beforeAll(async () => {
  keys = await createTestKeys();
  app = await createTestApp({ verifier: keys.verifier });
  fx = createFixtures(app.db);
});

afterAll(async () => {
  await fx.cleanup();
  await app.close();
});

/** A JPEG as a phone would produce it: EXIF orientation 6 (rotated) and camera metadata. */
function phoneJpeg(width = 2000, height = 1000) {
  return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 80 } } })
    .jpeg()
    .withMetadata({
      orientation: 6,
      exif: { IFD0: { Make: 'TestPhone', Model: 'GPS Leaker 9000' } },
    })
    .toBuffer();
}

function multipart(
  fields: Record<string, string>,
  file?: { data: Buffer; name?: string; type?: string },
) {
  const boundary = `----ohviana${randomBytes(8).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name ?? 'photo.jpg'}"\r\nContent-Type: ${file.type ?? 'image/jpeg'}\r\n\r\n`,
      ),
      file.data,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function setup(role: 'owner' | 'trek_lead' = 'owner') {
  const owner = await fx.user();
  const org = await fx.organizer();
  await fx.member(org, owner, role);
  const catalog = await fx.catalogTrek({
    name: `Photo Peak ${fx.tag} ${randomBytes(2).toString('hex')}`,
  });
  const [trek] = await app.db
    .insert(organizerTreks)
    .values({
      organizerId: org,
      catalogTrekId: catalog.id,
      title: 'Photo trek',
      slug: `p-${randomBytes(4).toString('hex')}`,
      status: 'published',
    })
    .returning();
  return {
    org,
    trek: trek!,
    catalog,
    auth: { authorization: `Bearer ${await keys.sign({ sub: owner })}` },
  };
}

const upload = (
  trekId: string,
  auth: Record<string, string>,
  fields: Record<string, string>,
  file?: Parameters<typeof multipart>[1],
) => {
  const { payload, headers } = multipart(fields, file);
  return app.inject({
    method: 'POST',
    url: `/v1/organizer/treks/${trekId}/photos`,
    headers: { ...auth, ...headers },
    payload,
  });
};

describe('trek photos', () => {
  it('stores a web-sized, correctly rotated WebP with metadata stripped', async () => {
    const s = await setup();
    const res = await upload(
      s.trek.id,
      s.auth,
      { category: 'transport', caption: 'Our bus' },
      { data: await phoneJpeg() },
    );
    expect(res.statusCode, res.body).toBe(201);
    const [photo] = res.json().photos;
    // 2000×1000 rotated by EXIF → portrait, then fitted inside 1600px.
    expect(photo).toMatchObject({
      category: 'transport',
      caption: 'Our bus',
      width: 800,
      height: 1600,
    });

    const img = await app.inject({ method: 'GET', url: photo.url });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/webp');
    expect(img.headers['cache-control']).toContain('immutable');
    const meta = await sharp(img.rawPayload).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 800, height: 1600 });
    expect(meta.exif).toBeUndefined();

    const thumb = await sharp(
      (await app.inject({ method: 'GET', url: photo.thumbUrl })).rawPayload,
    ).metadata();
    expect(Math.max(thumb.width!, thumb.height!)).toBeLessThanOrEqual(480);

    const cached = await app.inject({
      method: 'GET',
      url: photo.url,
      headers: { 'if-none-match': String(img.headers.etag) },
    });
    expect(cached.statusCode).toBe(304);
  });

  it('rejects files that are not images, too large, or of an unknown category', async () => {
    const s = await setup();
    expect(
      (
        await upload(
          s.trek.id,
          s.auth,
          {},
          { data: Buffer.from('not an image'), type: 'image/jpeg' },
        )
      ).statusCode,
    ).toBe(400);
    const huge = await upload(s.trek.id, s.auth, {}, { data: randomBytes(11 * 1024 * 1024) });
    expect(huge.statusCode).toBe(400);
    expect(huge.json().error.message).toContain('10 MB');
    expect(
      (await upload(s.trek.id, s.auth, { category: 'selfie' }, { data: await phoneJpeg(200, 100) }))
        .statusCode,
    ).toBe(400);
    expect((await upload(s.trek.id, s.auth, {})).statusCode).toBe(400);
  });

  it('lets owners edit and delete photos; the image is removed too', async () => {
    const s = await setup();
    const photo = (await upload(s.trek.id, s.auth, {}, { data: await phoneJpeg(300, 200) })).json()
      .photos[0];
    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/organizer/treks/${s.trek.id}/photos/${photo.id}`,
      headers: s.auth,
      payload: { category: 'stay', caption: 'Homestay', sortOrder: 5 },
    });
    expect(patched.json().photos[0]).toMatchObject({
      category: 'stay',
      caption: 'Homestay',
      sortOrder: 5,
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/organizer/treks/${s.trek.id}/photos/${photo.id}`,
      headers: s.auth,
    });
    expect(deleted.json().photos).toEqual([]);
    expect((await app.inject({ method: 'GET', url: photo.url })).statusCode).toBe(404);
  });

  it('blocks other organizers and trek leads', async () => {
    const mine = await setup();
    const theirs = await setup();
    const photo = (
      await upload(mine.trek.id, mine.auth, {}, { data: await phoneJpeg(300, 200) })
    ).json().photos[0];
    expect(
      (await upload(mine.trek.id, theirs.auth, {}, { data: await phoneJpeg(300, 200) })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/v1/organizer/treks/${mine.trek.id}/photos/${photo.id}`,
          headers: theirs.auth,
        })
      ).statusCode,
    ).toBe(404);

    const staff = await setup('trek_lead');
    expect(
      (await upload(staff.trek.id, staff.auth, {}, { data: await phoneJpeg(300, 200) })).statusCode,
    ).toBe(403);
  });

  it('caps a gallery at 20 photos', async () => {
    const s = await setup();
    const small = await phoneJpeg(120, 80);
    for (let i = 0; i < 20; i++)
      expect((await upload(s.trek.id, s.auth, {}, { data: small })).statusCode).toBe(201);
    expect((await upload(s.trek.id, s.auth, {}, { data: small })).statusCode).toBe(409);
  });

  it('shows photos to customers: departure galleries and trek cover images', async () => {
    const s = await setup();
    await upload(s.trek.id, s.auth, { category: 'transport' }, { data: await phoneJpeg(400, 300) });
    await upload(
      s.trek.id,
      s.auth,
      { category: 'destination', caption: 'Summit view' },
      { data: await phoneJpeg(400, 300) },
    );
    const departureAt = new Date(Date.now() + 9 * 86_400_000);
    const [batch] = await app.db
      .insert(batches)
      .values({
        name: `Test_Batch_${randomUUID()}`,
        organizerTrekId: s.trek.id,
        organizerId: s.org,
        departureAt,
        returnAt: new Date(departureAt.getTime() + 86_400_000),
        bookingCutoffAt: departureAt,
        pricePaise: 100_000,
        capacity: 10,
        status: 'published',
      })
      .returning();

    const pub = await app.inject({ method: 'GET', url: `/v1/batches/${batch!.id}` });
    expect(pub.json().trek.photos.map((p: { category: string }) => p.category)).toEqual([
      'transport',
      'destination',
    ]);

    const search = await app.inject({ method: 'GET', url: `/v1/treks/${s.catalog.slug}` });
    const cover = search.json().coverPhoto;
    // Destination shots are preferred for the cover.
    expect(cover.url).toBe(pub.json().trek.photos[1].url);
    await app.db
      .update(organizerTreks)
      .set({ status: 'draft' })
      .where(eq(organizerTreks.id, s.trek.id));
    expect(
      (await app.inject({ method: 'GET', url: `/v1/treks/${s.catalog.slug}` })).json().coverPhoto,
    ).toBeNull();
  });
});

describe('organizer logo', () => {
  it('uploads a logo, serves it, and shows it on the membership', async () => {
    const s = await setup();
    const { payload, headers } = multipart({}, { data: await phoneJpeg(600, 600) });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizer/profile/logo',
      headers: { ...s.auth, ...headers },
      payload,
    });
    expect(res.statusCode, res.body).toBe(200);
    const logoUrl = res.json().logoUrl as string;
    expect(logoUrl).toMatch(/^\/v1\/media\/[0-9a-f-]+-thumb\.webp$/);

    const image = await app.inject({ method: 'GET', url: logoUrl });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/webp');

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: s.auth });
    expect(me.json().memberships[0]).toMatchObject({ organizerId: s.org, logoUrl });
  });

  it("rejects non-images and trek leads' uploads", async () => {
    const s = await setup();
    const bad = multipart({}, { data: Buffer.from('not an image'), name: 'x.jpg' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/organizer/profile/logo',
          headers: { ...s.auth, ...bad.headers },
          payload: bad.payload,
        })
      ).statusCode,
    ).toBe(400);

    const lead = await setup('trek_lead');
    const ok = multipart({}, { data: await phoneJpeg(300, 300) });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/organizer/profile/logo',
          headers: { ...lead.auth, ...ok.headers },
          payload: ok.payload,
        })
      ).statusCode,
    ).toBe(403);
  });
});
