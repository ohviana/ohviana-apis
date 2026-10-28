import { createHash } from 'node:crypto';
import { batchName } from '@ohviana/shared';
import type { Database, Tx } from './client';
import {
  batchPickups,
  batches,
  catalogTreks,
  directLinks,
  organizers,
  organizerTreks,
  pickupPoints,
} from './schema/index';

/**
 * Deterministic UUID (v5-style layout) from a stable name, so re-running the seed upserts the
 * same rows instead of duplicating them.
 */
export function seedId(name: string): string {
  const h = createHash('sha1').update(`ohviana-seed:${name}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const seedToken = (name: string) =>
  createHash('sha256').update(`ohviana-seed-token:${name}`).digest('base64url').slice(0, 32);

const CATALOG = [
  {
    slug: 'kudremukh',
    name: 'Kudremukh',
    district: 'Chikkamagaluru',
    difficulty: 'moderate',
    maxAltitudeM: 1894,
    summary: 'Rolling grasslands and shola forests to the horse-face peak of the Western Ghats.',
  },
  {
    slug: 'kumara-parvatha',
    name: 'Kumara Parvatha',
    district: 'Dakshina Kannada',
    difficulty: 'difficult',
    maxAltitudeM: 1712,
    summary: 'One of the toughest treks in Karnataka, through dense forest to Pushpagiri.',
  },
  {
    slug: 'netravati-peak',
    name: 'Netravati Peak',
    district: 'Chikkamagaluru',
    difficulty: 'moderate',
    maxAltitudeM: 1520,
    summary: 'Ridge walk with sweeping views over the Kudremukh National Park.',
  },
  {
    slug: 'tadiandamol',
    name: 'Tadiandamol',
    district: 'Kodagu',
    difficulty: 'easy',
    maxAltitudeM: 1748,
    summary: 'The highest peak in Coorg, a beginner-friendly climb through coffee country.',
  },
  {
    slug: 'kodachadri',
    name: 'Kodachadri',
    district: 'Shivamogga',
    difficulty: 'moderate',
    maxAltitudeM: 1343,
    summary: 'Forest trail to the Sarvajna Peetha with famous sunset views.',
  },
] as const;

/** Fictional organizers for local development only. */
const ORGANIZERS = [
  {
    slug: 'ghats-trail-co',
    name: 'Ghats Trail Co. (Sample)',
    city: 'Bengaluru',
    tagline: 'Small groups, certified trek leaders.',
    treks: ['kudremukh', 'netravati-peak'],
  },
  {
    slug: 'summit-circle',
    name: 'Summit Circle (Sample)',
    city: 'Bengaluru',
    tagline: 'Weekend treks from Bengaluru since 2018.',
    treks: ['kumara-parvatha', 'kudremukh'],
  },
  {
    slug: 'coorg-wanderers',
    name: 'Coorg Wanderers (Sample)',
    city: 'Mysuru',
    tagline: 'Local guides who know every trail in Kodagu.',
    treks: ['tadiandamol', 'kodachadri'],
  },
] as const;

const PICKUPS = [
  { key: 'majestic', name: 'Majestic Bus Stand', landmark: 'Platform 1 entrance' },
  { key: 'silk-board', name: 'Silk Board Junction', landmark: 'Near the metro pillar 150' },
] as const;

/** Next Friday at 21:30 IST (16:00 UTC), at least 3 days from `from`. */
function firstDeparture(from: Date): Date {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + 3);
  d.setUTCHours(16, 0, 0, 0);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEKS = 6;

export interface SeedSummary {
  catalogTreks: number;
  organizers: number;
  organizerTreks: number;
  batches: number;
  directLinks: number;
}

export async function seed(db: Database | Tx, now: Date = new Date()): Promise<SeedSummary> {
  return db.transaction(async (tx) => {
    await tx
      .insert(catalogTreks)
      .values(
        CATALOG.map((c) => ({
          id: seedId(`catalog:${c.slug}`),
          ...c,
          state: 'Karnataka',
          region: 'Western Ghats',
          status: 'published' as const,
        })),
      )
      .onConflictDoNothing();

    const start = firstDeparture(now);
    let templateCount = 0;
    let batchCount = 0;
    let linkCount = 0;

    for (const [orgIndex, o] of ORGANIZERS.entries()) {
      const organizerId = seedId(`org:${o.slug}`);
      await tx
        .insert(organizers)
        .values({
          id: organizerId,
          slug: o.slug,
          name: o.name,
          city: o.city,
          tagline: o.tagline,
          description: `${o.name} is a sample organizer used for local development.`,
          status: 'approved',
          commissionRateBps: 750,
          contactEmail: `${o.slug}@example.com`,
        })
        .onConflictDoNothing();

      await tx
        .insert(directLinks)
        .values({
          id: seedId(`link:${o.slug}`),
          organizerId,
          token: seedToken(`org:${o.slug}`),
          label: 'Instagram bio link',
        })
        .onConflictDoNothing();
      linkCount++;

      for (const [trekIndex, catalogSlug] of o.treks.entries()) {
        const catalog = CATALOG.find((c) => c.slug === catalogSlug)!;
        const trekId = seedId(`trek:${o.slug}:${catalogSlug}`);
        templateCount++;

        await tx
          .insert(organizerTreks)
          .values({
            id: trekId,
            organizerId,
            catalogTrekId: seedId(`catalog:${catalogSlug}`),
            title: `${catalog.name} Weekend Trek`,
            slug: `${catalogSlug}-weekend`,
            summary: catalog.summary,
            durationDays: 2,
            itinerary: [
              { day: 1, title: 'Overnight travel from Bengaluru, trek to the summit' },
              { day: 2, title: 'Descend, lunch and return journey' },
            ],
            inclusions: [
              'Transport (non-AC bus)',
              'Breakfast and lunch',
              'Forest permits',
              'Trek leader',
            ],
            exclusions: ['Personal expenses', 'Anything not listed in inclusions'],
            thingsToCarry: ['2L water', 'Rain jacket', 'Trekking shoes', 'Torch'],
            cancellationPolicy:
              'Full refund up to 7 days before departure; 50% up to 3 days; no refund after that.',
            status: 'published',
          })
          .onConflictDoNothing();

        for (const [i, p] of PICKUPS.entries()) {
          await tx
            .insert(pickupPoints)
            .values({
              id: seedId(`pickup:${o.slug}:${catalogSlug}:${p.key}`),
              organizerTrekId: trekId,
              organizerId,
              name: p.name,
              landmark: p.landmark,
              sortOrder: i,
            })
            .onConflictDoNothing();
        }

        for (let week = 0; week < WEEKS; week++) {
          const departureAt = new Date(
            start.getTime() + week * 7 * DAY + (orgIndex + trekIndex) * HOUR,
          );
          const batchId = seedId(`batch:${o.slug}:${catalogSlug}:${week}`);
          batchCount++;

          const inserted = await tx
            .insert(batches)
            .values({
              id: batchId,
              organizerTrekId: trekId,
              organizerId,
              name: batchName({ organizer: o.name, place: catalog.name, departureAt, n: 1 }),
              departureAt,
              returnAt: new Date(departureAt.getTime() + 2 * DAY),
              bookingCutoffAt: new Date(departureAt.getTime() - 12 * HOUR),
              pricePaise: (2499 + orgIndex * 300 + trekIndex * 200) * 100,
              capacity: 20 + orgIndex * 5,
              status: week === WEEKS - 1 ? 'draft' : 'published',
              publishedAt: week === WEEKS - 1 ? null : now,
            })
            .onConflictDoNothing()
            .returning({ id: batches.id });

          if (inserted.length > 0) {
            await tx.insert(batchPickups).values(
              PICKUPS.map((p, i) => ({
                batchId,
                organizerTrekId: trekId,
                pickupPointId: seedId(`pickup:${o.slug}:${catalogSlug}:${p.key}`),
                pickupAt: new Date(departureAt.getTime() + i * 30 * 60_000),
              })),
            );
            // Every batch has its own booking link.
            await tx.insert(directLinks).values({
              id: seedId(`link:${o.slug}:${catalogSlug}:${week}`),
              organizerId,
              batchId,
              token: seedToken(`batch:${o.slug}:${catalogSlug}:${week}`),
            });
            linkCount++;
          }
        }
      }
    }

    return {
      catalogTreks: CATALOG.length,
      organizers: ORGANIZERS.length,
      organizerTreks: templateCount,
      batches: batchCount,
      directLinks: linkCount,
    };
  });
}
