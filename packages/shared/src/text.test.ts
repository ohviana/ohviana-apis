import { describe, expect, it } from 'vitest';
import { batchName, escapeLike, slugify } from './text';

describe('slugify', () => {
  it.each([
    ['Kudremukh', 'kudremukh'],
    ['Kumara Parvatha (Pushpagiri)', 'kumara-parvatha-pushpagiri'],
    ['  Sahyadri & Ghats  Trek!! ', 'sahyadri-and-ghats-trek'],
    ['Café Peak', 'cafe-peak'],
    ['---', ''],
  ])('%s -> %s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('never ends with a dash after truncation', () => {
    expect(slugify('aaaa bbbb', 5)).toBe('aaaa');
  });
});

describe('escapeLike', () => {
  it('escapes wildcard characters', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});

describe('batchName', () => {
  const at = (iso: string) => new Date(iso);
  it('builds organizer_place_date_Batch_n from the IST calendar day', () => {
    expect(
      batchName({
        organizer: 'RCB',
        place: 'Kudremukh',
        departureAt: at('2026-09-25T05:00:00+05:30'),
        n: 1,
      }),
    ).toBe('RCB_Kudremukh_25th_Sept_Batch_1');
    // 20:00 UTC on the 24th is already the 25th in India.
    expect(
      batchName({ organizer: 'RCB', place: 'x', departureAt: at('2026-09-24T20:00:00Z'), n: 2 }),
    ).toBe('RCB_X_25th_Sept_Batch_2');
  });

  it('cleans names and uses correct ordinals', () => {
    const name = (d: string) =>
      batchName({ organizer: 'Trek & Co.', place: 'DD hills (Tumkur)', departureAt: at(d), n: 3 });
    expect(name('2026-03-01T06:00:00+05:30')).toBe('Trek_Co_DD_Hills_Tumkur_1st_Mar_Batch_3');
    expect(name('2026-03-02T06:00:00+05:30')).toContain('_2nd_Mar_');
    expect(name('2026-03-03T06:00:00+05:30')).toContain('_3rd_Mar_');
    expect(name('2026-03-11T06:00:00+05:30')).toContain('_11th_Mar_');
    expect(name('2026-03-22T06:00:00+05:30')).toContain('_22nd_Mar_');
  });
});
