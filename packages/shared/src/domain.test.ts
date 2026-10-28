import { describe, expect, it } from 'vitest';
import { deriveBatchView, type BatchViewInput } from './domain';

const base: BatchViewInput = {
  status: 'published',
  departureAt: new Date('2026-11-10T00:00:00Z'),
  returnAt: new Date('2026-11-12T00:00:00Z'),
  bookingCutoffAt: new Date('2026-11-08T00:00:00Z'),
  capacity: 20,
  confirmedSeats: 5,
};

describe('deriveBatchView', () => {
  it.each([
    ['2026-11-01T00:00:00Z', {}, 'upcoming'],
    ['2026-11-01T00:00:00Z', { confirmedSeats: 20 }, 'sold_out'],
    ['2026-11-09T00:00:00Z', {}, 'booking_closed'],
    ['2026-11-11T00:00:00Z', {}, 'ongoing'],
    ['2026-11-13T00:00:00Z', {}, 'completed'],
    ['2026-11-01T00:00:00Z', { status: 'cancelled' }, 'cancelled'],
    ['2026-11-01T00:00:00Z', { status: 'draft' }, 'draft'],
  ] as const)('at %s with %o -> %s', (now, patch, expected) => {
    expect(deriveBatchView({ ...base, ...patch }, new Date(now))).toBe(expected);
  });
});
