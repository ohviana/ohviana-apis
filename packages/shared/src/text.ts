/** URL slug from free text: "Kumara Parvatha (Pushpagiri)" -> "kumara-parvatha-pushpagiri". */
export function slugify(input: string, maxLength = 80): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

/** Escapes `%`, `_` and `\` so user input is matched literally inside a LIKE/ILIKE pattern. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'June',
  'July',
  'Aug',
  'Sept',
  'Oct',
  'Nov',
  'Dec',
];

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** "DD hills" -> "DD_Hills"; drops punctuation, keeps the case of letters after the first. */
function namePart(input: string, maxLength: number): string {
  return (
    input
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((w) => w[0]!.toUpperCase() + w.slice(1))
      .join('_')
      .slice(0, maxLength)
      .replace(/_+$/, '') || 'Trek'
  );
}

/**
 * Generated batch name, e.g. "RCB_Kudremukh_25th_Sept_Batch_1". The date is the departure's
 * calendar day in India (IST); `n` counts batches of the same trek on that day.
 */
export function batchName(input: {
  organizer: string;
  place: string;
  departureAt: Date;
  n: number;
}): string {
  // IST has no DST: shifting by +5:30 and reading UTC fields gives the Indian calendar date.
  const ist = new Date(input.departureAt.getTime() + 330 * 60_000);
  return [
    namePart(input.organizer, 40),
    namePart(input.place, 60),
    ordinal(ist.getUTCDate()),
    MONTHS[ist.getUTCMonth()],
    'Batch',
    String(input.n),
  ].join('_');
}
