import type { OrganizerBooking } from '@ohviana/contracts';

/**
 * Spreadsheet-safe CSV cell: quoted, with formula-looking values neutralised so a guest named
 * "=HYPERLINK(...)" can't execute when a trek leader opens the file in Excel/Sheets.
 */
const SOURCE_LABELS = {
  MARKETPLACE: 'Marketplace',
  ORGANIZER_DIRECT: 'Direct link',
  ORGANIZER_OFFLINE: 'Added by organizer',
} as const;

export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  // A plain phone number (+919876543210) can't run as a formula, so it stays as is.
  if (/^[=+\-@\t\r]/.test(s) && !/^\+\d{8,15}$/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Byte-order mark so Excel opens UTF-8 (e.g. Kannada names) correctly. */
const UTF8_BOM = String.fromCharCode(0xfeff);

const ist = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

/**
 * One row per traveller of each confirmed booking, with that traveller's own phone and pickup:
 * the list a trek leader works from.
 */
export function attendeesCsv(bookings: OrganizerBooking[]): string {
  const header = [
    '#',
    'Traveller',
    'Traveller phone',
    'Age',
    'Gender',
    'Pickup',
    'Pickup time (IST)',
    'Booking reference',
    'Booked by',
    'Booked by phone',
    'Emergency contact',
    'Emergency phone',
    'Source',
    'Booked at (IST)',
  ];
  const rows = bookings
    .filter((b) => b.status === 'confirmed')
    .flatMap((b) =>
      b.guests.map((g) => [
        g.fullName,
        g.phone,
        g.age,
        g.gender,
        g.pickup?.name,
        g.pickup ? ist(g.pickup.pickupAt) : '',
        b.bookingReference,
        b.contact.name,
        b.contact.phone,
        b.emergencyContact?.name,
        b.emergencyContact?.phone,
        SOURCE_LABELS[b.source],
        ist(b.createdAt),
      ]),
    )
    .map((row, i) => [i + 1, ...row]);
  // BOM so Excel opens UTF-8 names (e.g. Kannada) correctly; CRLF per RFC 4180.
  return UTF8_BOM + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
