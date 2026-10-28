import { z } from 'zod';
import { CATALOG_REQUEST_STATUSES, ORGANIZER_STATUSES } from '@ohviana/shared';
import { CreateCatalogTrekRequest } from './catalog';
import { PaginationQuery, Uuid, paginated } from './common';

const Timestamp = z.iso.datetime();
const Note = z.string().trim().min(3).max(1000);
/** Commission in basis points: 750 = 7.5%. */
const CommissionBps = z.number().int().min(0).max(10_000);

// ---- Organizers ----

export const AdminOrganizer = z.object({
  id: Uuid,
  name: z.string(),
  slug: z.string(),
  status: z.enum(ORGANIZER_STATUSES),
  tagline: z.string().nullable(),
  city: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  gstin: z.string().nullable(),
  commissionRateBps: z.number().int(),
  reviewNote: z.string().nullable(),
  reviewedAt: Timestamp.nullable(),
  memberCount: z.number().int(),
  createdAt: Timestamp,
});
export type AdminOrganizer = z.infer<typeof AdminOrganizer>;

export const AdminOrganizerListQuery = PaginationQuery.extend({
  status: z.enum(ORGANIZER_STATUSES).optional(),
  query: z.string().trim().min(1).max(100).optional(),
});
export type AdminOrganizerListQuery = z.infer<typeof AdminOrganizerListQuery>;

export const AdminOrganizerList = paginated(AdminOrganizer);

/** Approval records the agreed marketplace commission (PRD: subject to organizer agreement). */
export const ApproveOrganizerRequest = z.object({
  commissionRateBps: CommissionBps,
  note: Note.optional(),
});
export type ApproveOrganizerRequest = z.infer<typeof ApproveOrganizerRequest>;

/** Reject and suspend must say why; the organizer sees this note. */
export const ReasonRequest = z.object({ note: Note });
export type ReasonRequest = z.infer<typeof ReasonRequest>;

export const ReinstateOrganizerRequest = z.object({ note: Note.optional() });

export const UpdateCommissionRequest = z.object({ commissionRateBps: CommissionBps, note: Note });
export type UpdateCommissionRequest = z.infer<typeof UpdateCommissionRequest>;

// ---- Catalog trek requests ----

export const CatalogRequest = z.object({
  id: Uuid,
  organizerId: Uuid,
  organizerName: z.string(),
  name: z.string(),
  state: z.string().nullable(),
  region: z.string().nullable(),
  district: z.string().nullable(),
  notes: z.string().nullable(),
  status: z.enum(CATALOG_REQUEST_STATUSES),
  catalogTrekId: Uuid.nullable(),
  reviewNote: z.string().nullable(),
  reviewedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type CatalogRequest = z.infer<typeof CatalogRequest>;

export const CatalogRequestListQuery = PaginationQuery.extend({
  status: z.enum(CATALOG_REQUEST_STATUSES).optional(),
});
export type CatalogRequestListQuery = z.infer<typeof CatalogRequestListQuery>;

export const CatalogRequestList = paginated(CatalogRequest);

/** Approve by linking an existing catalog trek, or by creating a new one. */
export const ApproveCatalogRequest = z.union([
  z.strictObject({ catalogTrekId: Uuid, note: Note.optional() }),
  z.strictObject({ create: CreateCatalogTrekRequest, note: Note.optional() }),
]);
export type ApproveCatalogRequest = z.infer<typeof ApproveCatalogRequest>;

export const ApproveCatalogRequestResponse = z.object({
  request: CatalogRequest,
  /** Draft organizer treks that were waiting on this request and are now linked. */
  linkedOrganizerTreks: z.number().int(),
});

// ---- Audit log ----

export const AuditEntry = z.object({
  id: Uuid,
  actorId: Uuid,
  actorEmail: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: Uuid.nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: Timestamp,
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AuditListQuery = PaginationQuery.extend({
  entityType: z.string().trim().min(1).max(50).optional(),
  entityId: Uuid.optional(),
  action: z.string().trim().min(1).max(100).optional(),
});
export type AuditListQuery = z.infer<typeof AuditListQuery>;

export const AuditList = paginated(AuditEntry);

export const IdParams = z.object({ id: Uuid });
