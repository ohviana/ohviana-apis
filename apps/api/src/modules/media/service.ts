import { and, asc, count, eq, inArray, max } from 'drizzle-orm';
import { media, trekPhotos, type Database, type Tx } from '@ohviana/db';
import type { TrekPhoto } from '@ohviana/contracts';
import type { PhotoCategory } from '@ohviana/shared';
import { conflict, notFound } from '../../lib/errors';
import { processImage } from '../../lib/images';

type Executor = Database | Tx;

export const MAX_PHOTOS_PER_TREK = 20;

/** Public, cache-forever URLs (the id never points at different bytes). */
export function mediaPaths(mediaId: string) {
  return { url: `/v1/media/${mediaId}.webp`, thumbUrl: `/v1/media/${mediaId}-thumb.webp` };
}

const photoColumns = {
  id: trekPhotos.id,
  organizerTrekId: trekPhotos.organizerTrekId,
  mediaId: trekPhotos.mediaId,
  category: trekPhotos.category,
  caption: trekPhotos.caption,
  sortOrder: trekPhotos.sortOrder,
  width: media.width,
  height: media.height,
};

/** Gallery photos for several treks at once (no image bytes), in display order. */
export async function loadTrekPhotos(
  db: Executor,
  trekIds: string[],
): Promise<Map<string, TrekPhoto[]>> {
  const map = new Map<string, TrekPhoto[]>();
  if (trekIds.length === 0) return map;
  const rows = await db
    .select(photoColumns)
    .from(trekPhotos)
    .innerJoin(media, eq(media.id, trekPhotos.mediaId))
    .where(inArray(trekPhotos.organizerTrekId, trekIds))
    .orderBy(asc(trekPhotos.sortOrder), asc(trekPhotos.createdAt));
  for (const r of rows) {
    const list = map.get(r.organizerTrekId) ?? [];
    list.push({
      id: r.id,
      ...mediaPaths(r.mediaId),
      category: r.category,
      caption: r.caption,
      width: r.width,
      height: r.height,
      sortOrder: r.sortOrder,
    });
    map.set(r.organizerTrekId, list);
  }
  return map;
}

/** Processes and stores an upload, appending it to the trek's gallery. */
export async function addTrekPhoto(
  db: Database,
  input: {
    organizerId: string;
    trekId: string;
    file: Buffer;
    category: PhotoCategory;
    caption: string | null;
  },
): Promise<void> {
  // Heavy work (decode/resize) happens before the transaction.
  const image = await processImage(input.file);

  await db.transaction(async (tx) => {
    const [stats] = await tx
      .select({ n: count(), last: max(trekPhotos.sortOrder) })
      .from(trekPhotos)
      .where(eq(trekPhotos.organizerTrekId, input.trekId));
    if ((stats?.n ?? 0) >= MAX_PHOTOS_PER_TREK) {
      throw conflict(`A trek can have up to ${MAX_PHOTOS_PER_TREK} photos; remove one first`);
    }
    const [stored] = await tx
      .insert(media)
      .values({
        organizerId: input.organizerId,
        contentType: image.contentType,
        width: image.width,
        height: image.height,
        bytes: image.bytes,
        thumbBytes: image.thumbBytes,
        sizeBytes: image.bytes.length,
        sha256: image.sha256,
      })
      .returning({ id: media.id });
    await tx.insert(trekPhotos).values({
      organizerTrekId: input.trekId,
      organizerId: input.organizerId,
      mediaId: stored!.id,
      category: input.category,
      caption: input.caption,
      sortOrder: (stats?.last ?? -1) + 1,
    });
  });
}

export async function updateTrekPhoto(
  db: Database,
  organizerId: string,
  trekId: string,
  photoId: string,
  patch: {
    category?: PhotoCategory | undefined;
    caption?: string | null | undefined;
    sortOrder?: number | undefined;
  },
): Promise<void> {
  const updated = await db
    .update(trekPhotos)
    .set({
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.caption !== undefined ? { caption: patch.caption || null } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
    })
    .where(
      and(
        eq(trekPhotos.id, photoId),
        eq(trekPhotos.organizerTrekId, trekId),
        eq(trekPhotos.organizerId, organizerId),
      ),
    )
    .returning({ id: trekPhotos.id });
  if (updated.length === 0) throw notFound('Photo');
}

/** Deletes the photo and its stored image. */
export async function deleteTrekPhoto(
  db: Database,
  organizerId: string,
  trekId: string,
  photoId: string,
): Promise<void> {
  const [photo] = await db
    .select({ mediaId: trekPhotos.mediaId })
    .from(trekPhotos)
    .where(
      and(
        eq(trekPhotos.id, photoId),
        eq(trekPhotos.organizerTrekId, trekId),
        eq(trekPhotos.organizerId, organizerId),
      ),
    );
  if (!photo) throw notFound('Photo');
  await db.delete(media).where(eq(media.id, photo.mediaId));
}

/** Image bytes for the public media route. */
export async function readMedia(db: Database, mediaId: string, variant: 'full' | 'thumb') {
  const [row] = await db
    .select({
      contentType: media.contentType,
      bytes: variant === 'full' ? media.bytes : media.thumbBytes,
      sha256: media.sha256,
    })
    .from(media)
    .where(eq(media.id, mediaId));
  return row ?? null;
}
