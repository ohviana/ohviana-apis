import { and, count, eq, like } from 'drizzle-orm';
import { createDb, organizers, organizerTreks, trekPhotos } from '@ohviana/db';
import type { PhotoCategory } from '@ohviana/shared';
import { addTrekPhoto } from '../modules/media/service';

/**
 * Dev only: gives the sample organizers' treks a photo gallery (free Unsplash photos via
 * picsum.photos), so the marketplace looks like it will with real organizers. Treks that
 * already have photos are skipped, so it is safe to re-run.
 *   npm run seed:photos -w @ohviana/api
 */
type Photo = [picsumId: number, category: PhotoCategory, caption: string];

const SUMMIT: Photo = [1018, 'destination', 'Grassland ridges near the summit'];
const VIEW: Photo = [1015, 'destination', 'The view from the top'];
const FOREST: Photo = [10, 'destination', 'Shola forest and the valley below'];
const PEAK: Photo = [29, 'destination', 'Peaks above the clouds'];
const RIDGE: Photo = [572, 'destination', 'Last stretch to the summit'];
const FALLS: Photo = [1039, 'destination', 'Waterfall on the way'];
const FALLS2: Photo = [1035, 'destination', 'Stop at the falls'];
const PATH: Photo = [17, 'trail', 'Easy start through the meadow'];
const RIVER: Photo = [1044, 'trail', 'River crossing'];
const STREAM: Photo = [28, 'trail', 'Forest trail along the stream'];
const ROCKS: Photo = [15, 'trail', 'Rocky section near the falls'];
const VALLEY: Photo = [1043, 'trail', 'Through the valley'];
const BUS: Photo = [183, 'transport', 'Our bus from Bengaluru'];
const CAMP: Photo = [1036, 'stay', 'Overnight camp'];
const COFFEE: Photo = [431, 'food', 'Filter coffee at breakfast'];
const MEAL: Photo = [292, 'food', 'Fresh lunch at base camp'];

/** Keyed by "<organizer slug>:<trek slug>" from the seed. */
const GALLERIES: Record<string, Photo[]> = {
  'ghats-trail-co:kudremukh-weekend': [SUMMIT, PATH, FALLS, BUS, COFFEE],
  'ghats-trail-co:netravati-peak-weekend': [FOREST, RIVER, CAMP, BUS],
  'summit-circle:kumara-parvatha-weekend': [PEAK, STREAM, FALLS2, MEAL],
  'summit-circle:kudremukh-weekend': [VIEW, VALLEY, BUS, CAMP],
  'coorg-wanderers:tadiandamol-weekend': [RIDGE, PATH, ROCKS, COFFEE],
  'coorg-wanderers:kodachadri-weekend': [FALLS, STREAM, CAMP, BUS],
};

async function download(id: number): Promise<Buffer> {
  const res = await fetch(`https://picsum.photos/id/${id}/1600/1067.jpg`);
  if (!res.ok) throw new Error(`photo ${id}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const { db, close } = createDb(process.env.DATABASE_URL ?? '', { max: 2 });
try {
  const cache = new Map<number, Buffer>();
  for (const [key, photos] of Object.entries(GALLERIES)) {
    const [orgSlug, trekSlug] = key.split(':') as [string, string];
    const [trek] = await db
      .select({ id: organizerTreks.id, organizerId: organizerTreks.organizerId })
      .from(organizerTreks)
      .innerJoin(organizers, eq(organizers.id, organizerTreks.organizerId))
      .where(
        and(
          eq(organizers.slug, orgSlug),
          eq(organizerTreks.slug, trekSlug),
          like(organizers.name, '%(Sample)'),
        ),
      );
    if (!trek) {
      console.warn(`skip ${key}: not found (run db:seed first)`);
      continue;
    }
    const [existing] = await db
      .select({ n: count() })
      .from(trekPhotos)
      .where(eq(trekPhotos.organizerTrekId, trek.id));
    if ((existing?.n ?? 0) > 0) {
      console.warn(`skip ${key}: already has photos`);
      continue;
    }
    for (const [id, category, caption] of photos) {
      if (!cache.has(id)) cache.set(id, await download(id));
      await addTrekPhoto(db, {
        organizerId: trek.organizerId,
        trekId: trek.id,
        file: cache.get(id)!,
        category,
        caption,
      });
    }
    console.warn(`${key}: added ${photos.length} photos`);
  }
} finally {
  await close();
}
