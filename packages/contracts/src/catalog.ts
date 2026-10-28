import { z } from 'zod';
import { CONTENT_STATUSES, DIFFICULTIES } from '@ohviana/shared';
import { PaginationQuery, Slug, Uuid, paginated } from './common';

const Timestamp = z.iso.datetime();
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable();

export const CatalogTrek = z.object({
  id: Uuid,
  name: z.string(),
  slug: z.string(),
  state: z.string().nullable(),
  region: z.string().nullable(),
  district: z.string().nullable(),
  difficulty: z.enum(DIFFICULTIES).nullable(),
  summary: z.string().nullable(),
  description: z.string().nullable(),
  maxAltitudeM: z.number().int().nullable(),
  heroImageUrl: z.string().nullable(),
  status: z.enum(CONTENT_STATUSES),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type CatalogTrek = z.infer<typeof CatalogTrek>;

const catalogTrekFields = {
  name: z.string().trim().min(2).max(120),
  slug: Slug,
  state: optionalText(80),
  region: optionalText(80),
  district: optionalText(80),
  difficulty: z.enum(DIFFICULTIES).nullable(),
  summary: optionalText(300),
  description: optionalText(10_000),
  maxAltitudeM: z.number().int().positive().max(9000).nullable(),
  heroImageUrl: z.url({ protocol: /^https$/ }).nullable(),
  status: z.enum(CONTENT_STATUSES),
};

/** `slug` defaults to a slug of `name`; `status` defaults to draft. */
export const CreateCatalogTrekRequest = z.object({
  ...catalogTrekFields,
  slug: catalogTrekFields.slug.optional(),
  state: catalogTrekFields.state.optional(),
  region: catalogTrekFields.region.optional(),
  district: catalogTrekFields.district.optional(),
  difficulty: catalogTrekFields.difficulty.optional(),
  summary: catalogTrekFields.summary.optional(),
  description: catalogTrekFields.description.optional(),
  maxAltitudeM: catalogTrekFields.maxAltitudeM.optional(),
  heroImageUrl: catalogTrekFields.heroImageUrl.optional(),
  status: catalogTrekFields.status.optional(),
});
export type CreateCatalogTrekRequest = z.infer<typeof CreateCatalogTrekRequest>;

export const UpdateCatalogTrekRequest = z
  .object(catalogTrekFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');
export type UpdateCatalogTrekRequest = z.infer<typeof UpdateCatalogTrekRequest>;

export const AdminCatalogTrekListQuery = PaginationQuery.extend({
  status: z.enum(CONTENT_STATUSES).optional(),
  query: z.string().trim().min(1).max(100).optional(),
});
export type AdminCatalogTrekListQuery = z.infer<typeof AdminCatalogTrekListQuery>;

export const CatalogTrekList = paginated(CatalogTrek);
export type CatalogTrekList = z.infer<typeof CatalogTrekList>;
