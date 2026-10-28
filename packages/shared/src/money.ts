/** All money is integer INR paise. Never use floating point for amounts. */
export type Paise = number;

export function assertPaise(value: number): asserts value is Paise {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Invalid paise amount: ${value}`);
  }
}

export function rupeesToPaise(rupees: number): Paise {
  const paise = Math.round(rupees * 100);
  assertPaise(paise);
  return paise;
}

/**
 * Commission from a basis-points rate (e.g. 750 bps = 7.5%), rounded half-up to the paise.
 */
export function commissionPaise(totalPaise: Paise, rateBps: number): Paise {
  assertPaise(totalPaise);
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new RangeError(`Invalid commission rate (bps): ${rateBps}`);
  }
  return Math.floor((totalPaise * rateBps + 5_000) / 10_000);
}

const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
});

export function formatInr(paise: Paise): string {
  return inrFormatter.format(paise / 100);
}
