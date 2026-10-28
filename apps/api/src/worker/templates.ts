import type { CustomerBooking } from '@ohviana/contracts';
import { formatInr } from '@ohviana/shared';
import type { EmailMessage } from './notifier';

const ist = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

const signature = '\n\n— Team Ohviana';

function bookingLines(b: CustomerBooking): string[] {
  return [
    `Booking reference: ${b.bookingReference}`,
    `Trek: ${b.batch.trekTitle} (${b.batch.catalogTrekName})`,
    `Organizer: ${b.batch.organizer.name}`,
    `Departs: ${ist(b.batch.departureAt)} IST`,
    ...(b.pickup ? [`Pickup: ${b.pickup.name} at ${ist(b.pickup.pickupAt)} IST`] : []),
    `Travellers (${b.quantity}): ${b.guests.map((g) => g.fullName).join(', ')}`,
    `Total: ${formatInr(b.totalPaise)}`,
  ];
}

export function bookingConfirmedCustomer(b: CustomerBooking, siteUrl: string): EmailMessage {
  return {
    to: b.contact.email!,
    subject: `Booked: ${b.batch.trekTitle} — ${b.bookingReference}`,
    text:
      [
        `Hi ${b.contact.name},`,
        '',
        'Your seats are confirmed.',
        '',
        ...bookingLines(b),
        '',
        `The organizer will contact you on ${b.contact.phone} with trip details.`,
        `View your booking: ${siteUrl}/bookings/${b.bookingReference} (on the device you booked with, or sign in)`,
        ...(b.cancellationPolicy ? ['', `Cancellation policy: ${b.cancellationPolicy}`] : []),
      ].join('\n') + signature,
  };
}

export function bookingConfirmedOrganizer(b: CustomerBooking, to: string): EmailMessage {
  return {
    to,
    subject: `New booking ${b.bookingReference}: ${b.quantity} seat(s) on ${b.batch.trekTitle}`,
    text:
      [
        `New ${b.source === 'ORGANIZER_DIRECT' ? 'direct-link' : 'marketplace'} booking.`,
        '',
        ...bookingLines(b),
        `Lead contact: ${b.contact.name}, ${b.contact.phone}${b.contact.email ? `, ${b.contact.email}` : ''}`,
      ].join('\n') + signature,
  };
}

export function bookingCancelledCustomer(
  b: CustomerBooking,
  by: 'customer' | 'organizer',
): EmailMessage {
  return {
    to: b.contact.email!,
    subject: `Cancelled: ${b.batch.trekTitle} — ${b.bookingReference}`,
    text:
      [
        `Hi ${b.contact.name},`,
        '',
        by === 'customer'
          ? 'Your booking has been cancelled as requested.'
          : `${b.batch.organizer.name} has cancelled your booking.`,
        ...(b.cancelReason ? [`Reason: ${b.cancelReason}`] : []),
        '',
        ...bookingLines(b),
        '',
        'For refunds, please contact the organizer.',
      ].join('\n') + signature,
  };
}

export function bookingCancelledOrganizer(b: CustomerBooking, to: string): EmailMessage {
  return {
    to,
    subject: `Booking cancelled ${b.bookingReference} (${b.quantity} seat(s) released)`,
    text:
      [...bookingLines(b), ...(b.cancelReason ? [`Reason: ${b.cancelReason}`] : [])].join('\n') +
      signature,
  };
}

export function organizerDecision(
  name: string,
  to: string,
  status: 'approved' | 'rejected' | 'suspended',
  note: string | null,
  siteUrl: string,
): EmailMessage {
  const body = {
    approved: `Good news — ${name} is approved on Ohviana. You can now publish batches and share direct booking links.`,
    rejected: `${name} could not be approved yet.`,
    suspended: `${name} has been suspended on Ohviana. Your departures are hidden and not bookable.`,
  }[status];
  return {
    to,
    subject: `Ohviana: ${name} ${status}`,
    text:
      [
        body,
        ...(note ? ['', `Note from Ohviana: ${note}`] : []),
        '',
        `Dashboard: ${siteUrl}/dashboard`,
      ].join('\n') + signature,
  };
}

export function adminNotice(to: string, subject: string, lines: string[]): EmailMessage {
  return { to, subject: `[Ohviana admin] ${subject}`, text: lines.join('\n') };
}
