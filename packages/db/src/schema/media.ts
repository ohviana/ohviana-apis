import { customType, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { check } from 'drizzle-orm/pg-core';
import { PHOTO_CATEGORIES } from '@ohviana/shared';
import { createdAt, id, inList } from './_helpers';
import { organizers } from './organizers';
import { organizerTreks } from './treks';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * Processed images (WebP, EXIF/GPS stripped) and their thumbnails. Kept in Postgres for a
 * zero-setup MVP behind the API's MediaStore; move the bytes to object storage at scale.
 */
export const media = pgTable(
  'media',
  {
    id: id(),
    organizerId: uuid('organizer_id').references(() => organizers.id, { onDelete: 'cascade' }),
    contentType: text('content_type').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    bytes: bytea('bytes').notNull(),
    thumbBytes: bytea('thumb_bytes').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('media_organizer_idx').on(t.organizerId)],
).enableRLS();

/** Photos in an organizer trek's gallery, tagged by what they show. */
export const trekPhotos = pgTable(
  'trek_photos',
  {
    id: id(),
    organizerTrekId: uuid('organizer_trek_id')
      .notNull()
      .references(() => organizerTreks.id, { onDelete: 'cascade' }),
    organizerId: uuid('organizer_id')
      .notNull()
      .references(() => organizers.id, { onDelete: 'cascade' }),
    mediaId: uuid('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    category: text('category', { enum: PHOTO_CATEGORIES }).notNull().default('destination'),
    caption: text('caption'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('trek_photos_trek_idx').on(t.organizerTrekId, t.sortOrder),
    uniqueIndex('trek_photos_media_uq').on(t.mediaId),
    check('trek_photos_category_ck', inList(t.category, PHOTO_CATEGORIES)),
    check('trek_photos_caption_ck', sql`${t.caption} is null or length(${t.caption}) <= 200`),
  ],
).enableRLS();
