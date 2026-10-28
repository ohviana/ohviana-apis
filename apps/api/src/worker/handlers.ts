import { eq, inArray } from 'drizzle-orm';
import { bookings, organizers, type Database } from '@ohviana/db';
import { loadCustomerBookings } from '../modules/bookings/read';
import type { Notifier } from './notifier';
import * as t from './templates';

export interface HandlerContext {
  db: Database;
  notifier: Notifier;
  siteUrl: string;
  /** Where admin notices (new registrations, catalog requests) go; unset = skip. */
  adminEmail: string | null;
}

type Payload = Record<string, unknown>;
export type Handler = (ctx: HandlerContext, payload: Payload) => Promise<void>;

const str = (v: unknown) => (typeof v === 'string' ? v : '');

async function organizerContact(db: Database, organizerId: string) {
  const [org] = await db
    .select({ name: organizers.name, email: organizers.contactEmail })
    .from(organizers)
    .where(eq(organizers.id, organizerId));
  return org;
}

async function loadBooking(db: Database, bookingId: string) {
  const [found] = await loadCustomerBookings(db, eq(bookings.id, bookingId));
  return found?.dto;
}

const organizerDecision =
  (status: 'approved' | 'rejected' | 'suspended'): Handler =>
  async (ctx, p) => {
    const org = await organizerContact(ctx.db, str(p.organizerId));
    if (!org?.email) return;
    await ctx.notifier.send(
      t.organizerDecision(
        org.name,
        org.email,
        status,
        (p.note as string | null) ?? null,
        ctx.siteUrl,
      ),
    );
  };

/**
 * Topic → side effect. Delivery is at-least-once: a handler that fails part-way is retried
 * whole, so a recipient may occasionally get a duplicate, but never miss a notification.
 */
export const HANDLERS: Record<string, Handler> = {
  'booking.confirmed': async (ctx, p) => {
    const b = await loadBooking(ctx.db, str(p.bookingId));
    if (!b) return;
    if (b.contact.email) await ctx.notifier.send(t.bookingConfirmedCustomer(b, ctx.siteUrl));
    const org = await organizerContact(ctx.db, str(p.organizerId));
    if (org?.email) await ctx.notifier.send(t.bookingConfirmedOrganizer(b, org.email));
  },

  'booking.cancelled': async (ctx, p) => {
    const b = await loadBooking(ctx.db, str(p.bookingId));
    if (!b) return;
    const by = p.by === 'organizer' ? 'organizer' : 'customer';
    if (b.contact.email) await ctx.notifier.send(t.bookingCancelledCustomer(b, by));
    if (by === 'customer') {
      const org = await organizerContact(ctx.db, str(p.organizerId));
      if (org?.email) await ctx.notifier.send(t.bookingCancelledOrganizer(b, org.email));
    }
  },

  'batch.cancelled': async (ctx, p) => {
    const ids = Array.isArray(p.bookingIds)
      ? p.bookingIds.filter((x): x is string => typeof x === 'string')
      : [];
    if (ids.length === 0) return;
    const affected = await loadCustomerBookings(ctx.db, inArray(bookings.id, ids));
    for (const { dto } of affected) {
      if (dto.contact.email) await ctx.notifier.send(t.bookingCancelledCustomer(dto, 'organizer'));
    }
  },

  'organizer.approved': organizerDecision('approved'),
  'organizer.rejected': organizerDecision('rejected'),
  'organizer.suspended': organizerDecision('suspended'),

  'organizer.registered': async (ctx, p) => {
    if (!ctx.adminEmail) return;
    await ctx.notifier.send(
      t.adminNotice(ctx.adminEmail, `New organizer: ${str(p.name)}`, [
        `${str(p.name)} registered and is awaiting review.`,
        `Review: ${ctx.siteUrl}/admin/organizers?status=pending`,
      ]),
    );
  },

  'catalog_trek.auto_created': async (ctx, p) => {
    if (!ctx.adminEmail) return;
    await ctx.notifier.send(
      t.adminNotice(ctx.adminEmail, `New catalog trek: ${str(p.name)}`, [
        `An organizer added "${str(p.name)}" to the catalog.`,
        `Review or tidy it: ${ctx.siteUrl}/admin/catalog/${str(p.catalogTrekId)}`,
      ]),
    );
  },

  'catalog_request.created': async (ctx, p) => {
    if (!ctx.adminEmail) return;
    await ctx.notifier.send(
      t.adminNotice(ctx.adminEmail, `Catalog request: ${str(p.name)}`, [
        `An organizer asked to add "${str(p.name)}" to the catalog.`,
        `Review: ${ctx.siteUrl}/admin/requests`,
      ]),
    );
  },

  'catalog_request.approved': async (ctx, p) => {
    const org = await organizerContact(ctx.db, str(p.organizerId));
    if (!org?.email) return;
    await ctx.notifier.send({
      to: org.email,
      subject: 'Ohviana: your catalog request was approved',
      text: `Your requested trek is now in the catalog${Number(p.linkedOrganizerTreks) > 0 ? ' and linked to your draft trek' : ''}. You can publish it from ${ctx.siteUrl}/dashboard/treks\n\n— Team Ohviana`,
    });
  },

  'catalog_request.rejected': async (ctx, p) => {
    const org = await organizerContact(ctx.db, str(p.organizerId));
    if (!org?.email) return;
    await ctx.notifier.send({
      to: org.email,
      subject: 'Ohviana: your catalog request was not approved',
      text: `${p.note ? `Note from Ohviana: ${str(p.note)}\n\n` : ''}Manage your treks: ${ctx.siteUrl}/dashboard/treks\n\n— Team Ohviana`,
    });
  },
};
