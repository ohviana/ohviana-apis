import { describe, expect, it } from 'vitest';
import { commissionPaise, rupeesToPaise } from './money';

describe('money', () => {
  it('converts rupees to integer paise', () => {
    expect(rupeesToPaise(1999)).toBe(199_900);
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30);
  });

  it('computes commission in basis points with half-up rounding', () => {
    expect(commissionPaise(399_800, 750)).toBe(29_985);
    expect(commissionPaise(399_800, 0)).toBe(0);
    expect(commissionPaise(1, 5_000)).toBe(1);
  });

  it('rejects invalid input', () => {
    expect(() => commissionPaise(-1, 100)).toThrow(RangeError);
    expect(() => commissionPaise(100, 10_001)).toThrow(RangeError);
  });
});
