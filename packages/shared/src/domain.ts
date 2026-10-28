/** Domain enumerations shared by DB, API and clients. Keep in sync with SQL CHECK constraints. */

export const ORGANIZER_STATUSES = ['pending', 'approved', 'rejected', 'suspended'] as const;
export type OrganizerStatus = (typeof ORGANIZER_STATUSES)[number];

/**
 * owner: created the organizer; exactly one, never changed.
 * co_owner: the same access as the owner, added on the Team page.
 * trek_lead: named (by mobile) on a batch; sees only the batches they lead.
 */
export const ORGANIZER_ROLES = ['owner', 'co_owner', 'trek_lead'] as const;
export type OrganizerRole = (typeof ORGANIZER_ROLES)[number];

export const CONTENT_STATUSES = ['draft', 'published', 'archived'] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/** Organizer requests for a new canonical catalog trek, reviewed by admins. */
export const CATALOG_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type CatalogRequestStatus = (typeof CATALOG_REQUEST_STATUSES)[number];

/** Stored batch lifecycle. `upcoming`, `ongoing`, `sold_out` are derived views (see deriveBatchView). */
export const BATCH_STATUSES = ['draft', 'published', 'cancelled', 'completed'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

/**
 * MARKETPLACE: booked on Ohviana. ORGANIZER_DIRECT: through the organizer's own booking link.
 * ORGANIZER_OFFLINE: added by the organizer (phone/WhatsApp/walk-in). Only MARKETPLACE pays commission.
 */
export const BOOKING_SOURCES = ['MARKETPLACE', 'ORGANIZER_DIRECT', 'ORGANIZER_OFFLINE'] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];

/** Payments are out of scope for now: a successful reservation is `confirmed` immediately. */
export const BOOKING_STATUSES = ['confirmed', 'cancelled'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** What a trek photo shows; organizers tag each upload. */
export const PHOTO_CATEGORIES = [
  'destination',
  'trail',
  'transport',
  'stay',
  'food',
  'group',
  'other',
] as const;
export type PhotoCategory = (typeof PHOTO_CATEGORIES)[number];

export const DIFFICULTIES = ['easy', 'moderate', 'difficult', 'challenging'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const BATCH_VIEWS = [
  'draft',
  'upcoming',
  'sold_out',
  'booking_closed',
  'ongoing',
  'completed',
  'cancelled',
] as const;
export type BatchView = (typeof BATCH_VIEWS)[number];

export interface BatchViewInput {
  status: BatchStatus;
  departureAt: Date;
  returnAt: Date;
  bookingCutoffAt: Date;
  capacity: number;
  confirmedSeats: number;
}

/** Derives the dashboard/listing view of a batch from stored status plus time and inventory. */
export function deriveBatchView(b: BatchViewInput, now: Date = new Date()): BatchView {
  if (b.status === 'draft' || b.status === 'cancelled' || b.status === 'completed') return b.status;
  if (now >= b.returnAt) return 'completed';
  if (now >= b.departureAt) return 'ongoing';
  if (b.confirmedSeats >= b.capacity) return 'sold_out';
  if (now >= b.bookingCutoffAt) return 'booking_closed';
  return 'upcoming';
}
