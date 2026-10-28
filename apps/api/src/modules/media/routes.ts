import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { notFound } from '../../lib/errors';
import { readMedia } from './service';

const MediaParams = z.object({
  file: z.string().regex(/^[0-9a-f-]{36}(-thumb)?\.webp$/, 'Unknown media'),
});

/** Public image delivery. URLs are content-stable, so browsers and CDNs cache them for a year. */
export const mediaRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/media/:file',
    {
      config: { rateLimit: false },
      schema: { tags: ['public'], summary: 'Trek photo (WebP)', params: MediaParams, hide: true },
    },
    async (request, reply) => {
      const { file } = request.params;
      const variant = file.includes('-thumb') ? 'thumb' : 'full';
      const id = file.slice(0, 36);
      const row = await readMedia(app.db, id, variant);
      if (!row) throw notFound('Image');

      const etag = `"${row.sha256.slice(0, 32)}-${variant}"`;
      reply
        .header('content-type', row.contentType)
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header('etag', etag)
        // Images may be embedded by the website on another origin.
        .header('cross-origin-resource-policy', 'cross-origin');
      if (request.headers['if-none-match'] === etag) return reply.status(304).send();
      return reply.send(row.bytes);
    },
  );
};
