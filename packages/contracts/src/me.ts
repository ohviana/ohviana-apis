import { z } from 'zod';
import { ORGANIZER_ROLES, ORGANIZER_STATUSES } from '@ohviana/shared';
import { Uuid } from './common';

/** Indian or international mobile in E.164 form, e.g. +919876543210. */
export const PhoneE164 = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'Phone must be in E.164 format, e.g. +919876543210');

export const Membership = z.object({
  organizerId: Uuid,
  name: z.string(),
  slug: z.string(),
  status: z.enum(ORGANIZER_STATUSES),
  role: z.enum(ORGANIZER_ROLES),
  /** An https link, or an API path (/v1/media/…) for an uploaded logo. */
  logoUrl: z.string().nullable(),
});
export type Membership = z.infer<typeof Membership>;

export const MeResponse = z.object({
  user: z.object({
    id: Uuid,
    email: z.string().nullable(),
    fullName: z.string().nullable(),
    phone: z.string().nullable(),
  }),
  isAdmin: z.boolean(),
  memberships: z.array(Membership),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const UpdateMeRequest = z
  .object({
    fullName: z.string().trim().min(1).max(120),
    phone: PhoneE164.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');
export type UpdateMeRequest = z.infer<typeof UpdateMeRequest>;
