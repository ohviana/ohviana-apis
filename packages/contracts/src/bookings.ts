import { z } from 'zod';
import { BOOKING_SOURCES, BOOKING_STATUSES } from '@ohviana/shared';
import { PaginationQuery, Uuid, paginated } from './common';
import { PhoneE164 } from './me';

const Timestamp = z.iso.datetime();
const Name = z.string().trim().min(2).max(120);

export const IDEMPOTENCY_HEADER = 'idempotency-key';
/** Guests (no account) authorize with the secret returned at booking time. */
export const BOOKING_TOKEN_HEADER = 'x-booking-token';

export const BookingGuestInput = z.object({
  fullName: Name,
  phone: PhoneE164.optional(),
  age: z.number().int().min(1).max(120).optional(),
  gender: z.enum(['female', 'male', 'other']).optional(),
  /** Where this traveller boards; defaults to the booking's pickup point. */
  pickupPointId: Uuid.optional(),
});

export const CreateBookingRequest = z
  .object({
    batchId: Uuid,
    quantity: z.number().int().min(1).max(50),
    /** Direct-link token when the customer arrived through an organizer's link. */
    entryToken: z.string().min(16).max(64).optional(),
    pickupPointId: Uuid.optional(),
    contact: z.object({
      name: Name,
      phone: PhoneE164,
      email: z
        .email()
        .max(254)
        .transform((e) => e.toLowerCase())
        .optional(),
    }),
    emergencyContact: z.object({ name: Name, phone: PhoneE164 }).optional(),
    /** Every traveller, including the lead contact if they are travelling. */
    guests: z.array(BookingGuestInput).min(1).max(50),
  })
  .refine((b) => b.guests.length === b.quantity, {
    message: 'Provide one guest per seat',
    path: ['guests'],
  });
export type CreateBookingRequest = z.infer<typeof CreateBookingRequest>;

const BookingGuest = z.object({
  fullName: z.string(),
  phone: z.string().nullable(),
  age: z.number().int().nullable(),
  gender: z.string().nullable(),
  /** This traveller's boarding point (their own, else the booking's). */
  pickup: z.object({ name: z.string(), pickupAt: Timestamp }).nullable(),
});

const BookingBatch = z.object({
  id: Uuid,
  departureAt: Timestamp,
  returnAt: Timestamp,
  trekTitle: z.string(),
  catalogTrekName: z.string(),
  organizer: z.object({ id: Uuid, name: z.string(), slug: z.string() }),
});

/** What the customer sees. Commission is deliberately absent. */
export const CustomerBooking = z.object({
  bookingReference: z.string(),
  status: z.enum(BOOKING_STATUSES),
  source: z.enum(BOOKING_SOURCES),
  quantity: z.number().int(),
  unitPricePaise: z.number().int(),
  totalPaise: z.number().int(),
  batch: BookingBatch,
  pickup: z.object({ name: z.string(), pickupAt: Timestamp }).nullable(),
  contact: z.object({ name: z.string(), phone: z.string(), email: z.string().nullable() }),
  guests: z.array(BookingGuest),
  cancellationPolicy: z.string().nullable(),
  cancelledAt: Timestamp.nullable(),
  cancelReason: z.string().nullable(),
  createdAt: Timestamp,
});
export type CustomerBooking = z.infer<typeof CustomerBooking>;

export const CreateBookingResponse = CustomerBooking.extend({
  /**
   * Shown once: lets the customer view or cancel this booking without an account (send as
   * the x-booking-token header). Store it with the booking reference.
   */
  accessToken: z.string(),
});
export type CreateBookingResponse = z.infer<typeof CreateBookingResponse>;

export const BookingReferenceParams = z.object({
  reference: z.string().regex(/^[A-Z]{3}-[A-Z0-9]{6,12}$/, 'Invalid booking reference'),
});

export const CancelBookingRequest = z.object({
  reason: z.string().trim().min(3).max(1000).optional(),
});

export const MyBookingList = paginated(CustomerBooking);
export const MyBookingsQuery = PaginationQuery;

// ---------- Organizer view ----------

export const OrganizerBooking = CustomerBooking.extend({
  commissionRateBps: z.number().int(),
  commissionPaise: z.number().int(),
  emergencyContact: z.object({ name: z.string(), phone: z.string() }).nullable(),
});
export type OrganizerBooking = z.infer<typeof OrganizerBooking>;

export const OrganizerBookingList = z.object({
  items: z.array(OrganizerBooking),
  totals: z.object({
    confirmedBookings: z.number().int(),
    confirmedSeats: z.number().int(),
    cancelledBookings: z.number().int(),
  }),
});

export const OrganizerCancelBookingRequest = z.object({
  reason: z.string().trim().min(3).max(1000),
});

/**
 * The organizer adds people who booked outside Ohviana (phone, WhatsApp, walk-in) to a batch.
 * Their seats count against capacity like any booking; no commission applies.
 */
export const AddBatchMembersRequest = z.object({
  contact: z.object({
    name: Name,
    phone: PhoneE164,
    email: z
      .email()
      .max(254)
      .transform((e) => e.toLowerCase())
      .optional(),
  }),
  /** One entry per seat, including the contact if they are travelling. */
  guests: z.array(BookingGuestInput).min(1).max(50),
  pickupPointId: Uuid.optional(),
  /** Per-seat price actually charged; defaults to the batch price. */
  unitPricePaise: z.number().int().min(0).max(100_000_000).optional(),
});
export type AddBatchMembersRequest = z.infer<typeof AddBatchMembersRequest>;
