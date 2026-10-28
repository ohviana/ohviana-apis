import { z } from 'zod';
import {
  PHOTO_CATEGORIES,
  BATCH_STATUSES,
  BATCH_VIEWS,
  CATALOG_REQUEST_STATUSES,
  CONTENT_STATUSES,
  DIFFICULTIES,
  ORGANIZER_ROLES,
  ORGANIZER_STATUSES,
} from '@ohviana/shared';
import { PaginationQuery, Slug, Uuid, paginated } from './common';
import { PhoneE164 } from './me';

const Timestamp = z.iso.datetime();
/** Accepts any ISO-8601 instant with an offset (e.g. +05:30); stored and returned as UTC. */
const InstantInput = z.iso.datetime({ offset: true });
const Text = (max: number) => z.string().trim().min(1).max(max);
const Email = z
  .email()
  .max(254)
  .transform((e) => e.toLowerCase());
/** Indian GSTIN: 15 characters, e.g. 29ABCDE1234F1Z5. */
const Gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN');

// ---------- Registration & profile ----------

export const RegisterOrganizerRequest = z.object({
  name: Text(120),
  slug: Slug.optional(),
  tagline: Text(160).optional(),
  description: Text(5000).optional(),
  city: Text(80).optional(),
  /** A link to the logo; to upload a photo instead, register first, then POST /profile/logo. */
  logoUrl: z.url({ protocol: /^https$/ }).optional(),
  contactEmail: Email,
  contactPhone: PhoneE164,
  gstin: Gstin.optional(),
});
export type RegisterOrganizerRequest = z.infer<typeof RegisterOrganizerRequest>;

export const OrganizerProfile = z.object({
  id: Uuid,
  name: z.string(),
  slug: z.string(),
  status: z.enum(ORGANIZER_STATUSES),
  tagline: z.string().nullable(),
  description: z.string().nullable(),
  logoUrl: z.string().nullable(),
  city: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  gstin: z.string().nullable(),
  commissionRateBps: z.number().int(),
  /** Admin's note on the last review (e.g. reason for rejection). */
  reviewNote: z.string().nullable(),
  reviewedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type OrganizerProfile = z.infer<typeof OrganizerProfile>;

/** Slug can only change while pending: after approval, public URLs depend on it. */
export const UpdateOrganizerProfileRequest = z
  .object({
    name: Text(120),
    slug: Slug,
    tagline: Text(160).nullable(),
    description: Text(5000).nullable(),
    logoUrl: z.url({ protocol: /^https$/ }).nullable(),
    city: Text(80).nullable(),
    contactEmail: Email,
    contactPhone: PhoneE164,
    gstin: Gstin.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');
export type UpdateOrganizerProfileRequest = z.infer<typeof UpdateOrganizerProfileRequest>;

// ---------- Members ----------

export const Member = z.object({
  userId: Uuid,
  email: z.string().nullable(),
  phone: z.string().nullable(),
  fullName: z.string().nullable(),
  role: z.enum(ORGANIZER_ROLES),
  createdAt: Timestamp,
});
export type Member = z.infer<typeof Member>;

export const MemberList = z.object({ items: z.array(Member) });

/** Adds a co-owner: someone who has signed in to Ohviana once, found by email or mobile. */
export const AddMemberRequest = z
  .object({ email: Email.optional(), phone: PhoneE164.optional() })
  .refine((v) => !!v.email !== !!v.phone, 'Give an email or a mobile number');
export type AddMemberRequest = z.infer<typeof AddMemberRequest>;

/** The only role change the Team page makes: a trek lead becomes a co-owner. */
export const UpdateMemberRequest = z.object({ role: z.literal('co_owner') });

/** Someone named as a lead on the organizer's batches, by mobile. */
export const TrekLeadSummary = z.object({
  phone: z.string(),
  name: z.string(),
  batchCount: z.number().int(),
  nextDepartureAt: Timestamp.nullable(),
  /** active: signed in and has access; not_signed_in: gets access on first sign-in. */
  status: z.enum(['active', 'not_signed_in', 'revoked']),
});
export type TrekLeadSummary = z.infer<typeof TrekLeadSummary>;
export const TrekLeadList = z.object({ items: z.array(TrekLeadSummary) });
export const TrekLeadRequest = z.object({ phone: PhoneE164 });

export const MemberParams = z.object({ userId: Uuid });

// ---------- Catalog (organizer view) ----------

export const OrganizerCatalogQuery = PaginationQuery.extend({
  query: z.string().trim().min(1).max(100).optional(),
});

export const CreateCatalogRequestRequest = z.object({
  name: Text(120),
  state: Text(80).optional(),
  region: Text(80).optional(),
  district: Text(80).optional(),
  notes: Text(2000).optional(),
});
export type CreateCatalogRequestRequest = z.infer<typeof CreateCatalogRequestRequest>;

export const OrganizerCatalogRequest = z.object({
  id: Uuid,
  name: z.string(),
  state: z.string().nullable(),
  region: z.string().nullable(),
  district: z.string().nullable(),
  notes: z.string().nullable(),
  status: z.enum(CATALOG_REQUEST_STATUSES),
  catalogTrekId: Uuid.nullable(),
  reviewNote: z.string().nullable(),
  createdAt: Timestamp,
});
export const OrganizerCatalogRequestList = z.object({ items: z.array(OrganizerCatalogRequest) });

// ---------- Trek templates ----------

export const ItineraryDay = z.object({
  /** 0 = the night before (e.g. overnight bus), then day 1, 2, … */
  day: z.number().int().min(0).max(60),
  title: Text(200),
  details: Text(2000).optional(),
});

const StringList = z.array(Text(300)).max(50);

const trekFields = {
  catalogTrekId: Uuid.nullable(),
  /**
   * Destination by name, e.g. "Devarayanadurga". Reuses the catalog trek with the same name,
   * or adds it to the catalog instantly (no admin approval). Alternative to `catalogTrekId`.
   */
  catalogTrekName: Text(120),
  /** District for a newly added catalog trek (optional). */
  catalogDistrict: Text(80),
  catalogTrekRequestId: Uuid.nullable(),
  title: Text(160),
  slug: Slug,
  summary: Text(500).nullable(),
  durationDays: z.number().int().min(1).max(60).nullable(),
  difficulty: z.enum(DIFFICULTIES).nullable(),
  maxAltitudeM: z.number().int().min(1).max(9000).nullable(),
  startPoint: Text(80).nullable(),
  itinerary: z.array(ItineraryDay).max(61),
  inclusions: StringList,
  exclusions: StringList,
  thingsToCarry: StringList,
  cancellationPolicy: Text(5000).nullable(),
  /**
   * Treks have no drafts: saved with a destination means live. `archived` takes one down,
   * `published` brings it back.
   */
  status: z.enum(['published', 'archived']),
};

export const UpdateOrganizerTrekRequest = z
  .object(trekFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');
export type UpdateOrganizerTrekRequest = z.infer<typeof UpdateOrganizerTrekRequest>;

export const PickupPoint = z.object({
  id: Uuid,
  name: z.string(),
  address: z.string().nullable(),
  landmark: z.string().nullable(),
  mapsUrl: z.string().nullable(),
  sortOrder: z.number().int(),
});
export type PickupPoint = z.infer<typeof PickupPoint>;

/** A gallery photo. `url`/`thumbUrl` are API paths (prefix with the API base URL). */
export const TrekPhoto = z.object({
  id: Uuid,
  url: z.string(),
  thumbUrl: z.string(),
  category: z.enum(PHOTO_CATEGORIES),
  caption: z.string().nullable(),
  width: z.number().int(),
  height: z.number().int(),
  sortOrder: z.number().int(),
});
export type TrekPhoto = z.infer<typeof TrekPhoto>;

export const UpdateTrekPhotoRequest = z
  .object({
    category: z.enum(PHOTO_CATEGORIES),
    caption: z.string().trim().max(200).nullable(),
    sortOrder: z.number().int().min(0).max(1000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

export const PhotoParams = z.object({ id: Uuid, photoId: Uuid });

export const OrganizerTrek = z.object({
  id: Uuid,
  catalogTrekId: Uuid.nullable(),
  catalogTrekName: z.string().nullable(),
  catalogTrekRequestId: Uuid.nullable(),
  title: z.string(),
  slug: z.string(),
  summary: z.string().nullable(),
  durationDays: z.number().int().nullable(),
  difficulty: z.enum(DIFFICULTIES).nullable(),
  maxAltitudeM: z.number().int().nullable(),
  startPoint: z.string().nullable(),
  itinerary: z.array(ItineraryDay),
  inclusions: z.array(z.string()),
  exclusions: z.array(z.string()),
  thingsToCarry: z.array(z.string()),
  cancellationPolicy: z.string().nullable(),
  status: z.enum(CONTENT_STATUSES),
  pickupPoints: z.array(PickupPoint),
  photos: z.array(TrekPhoto),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type OrganizerTrek = z.infer<typeof OrganizerTrek>;

export const OrganizerTrekListQuery = z.object({ status: z.enum(CONTENT_STATUSES).optional() });
export const OrganizerTrekList = z.object({ items: z.array(OrganizerTrek) });

const pickupFields = {
  name: Text(120),
  address: Text(300).nullable(),
  landmark: Text(200).nullable(),
  mapsUrl: z.url({ protocol: /^https$/ }).nullable(),
  sortOrder: z.number().int().min(0).max(1000),
};
export const CreatePickupPointRequest = z.object(pickupFields).partial().required({ name: true });
export const UpdatePickupPointRequest = z
  .object(pickupFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

export const TrekParams = z.object({ id: Uuid });
export const PickupParams = z.object({ id: Uuid, pickupId: Uuid });

// ---------- Batches ----------

export const BatchPickup = z.object({
  pickupPointId: Uuid,
  name: z.string(),
  pickupAt: Timestamp,
});

/** A trek lead for one departure (shown to the organizer's team). */
export const TripLead = z.object({ name: Text(80), phone: PhoneE164 });
export type TripLead = z.infer<typeof TripLead>;

export const OrganizerBatch = z.object({
  id: Uuid,
  organizerTrekId: Uuid,
  /** Generated, e.g. "RCB_Kudremukh_25th_Sept_Batch_1". */
  name: z.string(),
  trekTitle: z.string(),
  departureAt: Timestamp,
  returnAt: Timestamp,
  bookingCutoffAt: Timestamp,
  pricePaise: z.number().int(),
  capacity: z.number().int(),
  confirmedSeats: z.number().int(),
  seatsLeft: z.number().int(),
  maxSeatsPerBooking: z.number().int(),
  status: z.enum(BATCH_STATUSES),
  /** Dashboard view derived from status, time and seats. */
  view: z.enum(BATCH_VIEWS),
  notes: z.string().nullable(),
  publishedAt: Timestamp.nullable(),
  cancelledAt: Timestamp.nullable(),
  cancelReason: z.string().nullable(),
  /** Token of the batch's booking link (created with the batch); bookings via it are 0% commission. */
  bookingLinkToken: z.string().nullable(),
  pickups: z.array(BatchPickup),
  leads: z.array(z.object({ name: z.string(), phone: z.string() })),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type OrganizerBatch = z.infer<typeof OrganizerBatch>;

export const BatchPickupInput = z.object({ pickupPointId: Uuid, pickupAt: InstantInput });

const Departure = z.object({
  departureAt: InstantInput,
  returnAt: InstantInput,
  /** Defaults to the departure time. */
  bookingCutoffAt: InstantInput.optional(),
});

const batchCommon = {
  pricePaise: z.number().int().min(0).max(100_000_000),
  capacity: z.number().int().min(1).max(500),
  maxSeatsPerBooking: z.number().int().min(1).max(50).optional(),
  notes: Text(2000).optional(),
  leads: z.array(TripLead).max(5).optional(),
};

export const CreateBatchRequest = Departure.extend({
  ...batchCommon,
  pickups: z.array(BatchPickupInput).max(20).optional(),
});
export type CreateBatchRequest = z.infer<typeof CreateBatchRequest>;

/**
 * Many independent departures of one template in one atomic call (e.g. every Friday for
 * 8 weeks). Pickup times are given as offsets from each departure.
 */
export const BulkCreateBatchesRequest = z.object({
  ...batchCommon,
  departures: z.array(Departure).min(1).max(52),
  /**
   * An existing pickup point by id, or a new one by name (reused if the trek already has a
   * point with that name). Times are offsets from each departure.
   */
  pickups: z
    .array(
      z
        .object({
          pickupPointId: Uuid.optional(),
          name: Text(120).optional(),
          minutesFromDeparture: z.number().int().min(-1440).max(1440),
        })
        .refine((p) => !!p.pickupPointId !== !!p.name, 'Give either pickupPointId or name'),
    )
    .max(20)
    .optional(),
  /** Publish every new batch at once (organizer must be approved); default saves drafts. */
  publish: z.boolean().optional(),
});
export type BulkCreateBatchesRequest = z.infer<typeof BulkCreateBatchesRequest>;

export const UpdateBatchRequest = z
  .object({
    departureAt: InstantInput,
    returnAt: InstantInput,
    bookingCutoffAt: InstantInput,
    pricePaise: batchCommon.pricePaise,
    capacity: batchCommon.capacity,
    maxSeatsPerBooking: z.number().int().min(1).max(50),
    notes: Text(2000).nullable(),
    leads: z.array(TripLead).max(5),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');
export type UpdateBatchRequest = z.infer<typeof UpdateBatchRequest>;

export const SetBatchPickupsRequest = z.object({ pickups: z.array(BatchPickupInput).max(20) });

export const CancelBatchRequest = z.object({ reason: Text(1000) });

export const OrganizerBatchListQuery = PaginationQuery.extend({
  view: z.enum(BATCH_VIEWS).optional(),
  trekId: Uuid.optional(),
  from: InstantInput.optional(),
  to: InstantInput.optional(),
});
export type OrganizerBatchListQuery = z.infer<typeof OrganizerBatchListQuery>;

export const OrganizerBatchList = paginated(OrganizerBatch);
export const OrganizerBatchArray = z.object({ items: z.array(OrganizerBatch) });

/** New dates for a copy of an existing batch (price, seats, pickups and notes are reused). */
export const RepeatBatchRequest = Departure.extend({
  /** Save as draft (default) or publish straight away. */
  publish: z.boolean().optional(),
});
export type RepeatBatchRequest = z.infer<typeof RepeatBatchRequest>;

// ---------- Create trek (one form) ----------

export const NewTrekPickup = z.object({
  name: Text(120),
  landmark: Text(200).optional(),
  address: Text(300).optional(),
  mapsUrl: z.url({ protocol: /^https$/ }).optional(),
  /** Pickup time for the first batch; defaults to its departure time. */
  pickupAt: InstantInput.optional(),
});

/**
 * Everything in one request: trek details, pickup points, and optionally its first batch.
 * `publish: true` makes the batch (and trek) bookable at once; otherwise all is saved as draft.
 */
export const CreateOrganizerTrekRequest = z
  .object(trekFields)
  .partial()
  .required({ title: true })
  .extend({
    pickupPoints: z.array(NewTrekPickup).max(20).optional(),
    firstBatch: Departure.extend(batchCommon).optional(),
    publish: z.boolean().optional(),
  });
export type CreateOrganizerTrekRequest = z.infer<typeof CreateOrganizerTrekRequest>;

// ---------- Direct links ----------

export const DirectLink = z.object({
  id: Uuid,
  batchId: Uuid.nullable(),
  token: z.string(),
  label: z.string().nullable(),
  active: z.boolean(),
  expiresAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type DirectLink = z.infer<typeof DirectLink>;

export const CreateDirectLinkRequest = z.object({
  /** Omit for an organizer-wide link that works for any of the organizer's batches. */
  batchId: Uuid.optional(),
  label: Text(120).optional(),
  expiresAt: InstantInput.optional(),
});
export type CreateDirectLinkRequest = z.infer<typeof CreateDirectLinkRequest>;

export const DirectLinkList = z.object({ items: z.array(DirectLink) });

// ---------- Dashboard ----------

/** Confirmed bookings of one channel (or all of them). */
const BookingTotals = z.object({
  confirmed: z.number().int(),
  seatsSold: z.number().int(),
  grossPaise: z.number().int(),
  commissionPaise: z.number().int(),
});

export const DashboardSummary = z.object({
  batches: z.record(z.enum(BATCH_VIEWS), z.number().int()),
  bookings: BookingTotals.extend({
    /** Per booking source; the three add up to the totals above. */
    channels: z.object({
      /** Booked on Ohviana (the only channel that pays commission). */
      marketplace: BookingTotals,
      /** Booked through the organizer's own booking links. */
      directLink: BookingTotals,
      /** Added by the organizer (phone, WhatsApp, walk-in). */
      addedByYou: BookingTotals,
    }),
  }),
});
export type DashboardSummary = z.infer<typeof DashboardSummary>;
