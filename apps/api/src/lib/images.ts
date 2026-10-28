import { createHash } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';
import { AppError } from './errors';

/** Raw upload limit; anything a phone camera produces fits comfortably. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_EDGE = 1600;
const THUMB_EDGE = 480;
/** Refuse decompression bombs (e.g. a tiny file claiming 100k × 100k pixels). */
const MAX_INPUT_PIXELS = 60_000_000;

export interface ProcessedImage {
  bytes: Buffer;
  thumbBytes: Buffer;
  width: number;
  height: number;
  contentType: 'image/webp';
  sha256: string;
}

/**
 * Validates and normalises an uploaded photo: decodes it (the bytes decide the format, not the
 * file name), applies the camera's rotation, fits it within 1600px, re-encodes as WebP and
 * makes a 480px thumbnail. Re-encoding drops all metadata, including EXIF GPS location.
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw unsupported();
  }
  if (
    !meta.format ||
    !['jpeg', 'png', 'webp', 'heif', 'avif', 'gif', 'tiff'].includes(meta.format)
  ) {
    throw unsupported();
  }
  try {
    const base = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate();
    const { data: bytes, info } = await base
      .clone()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    const thumbBytes = await base
      .clone()
      .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();
    return {
      bytes,
      thumbBytes,
      width: info.width,
      height: info.height,
      contentType: 'image/webp',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    throw unsupported();
  }
}

function unsupported() {
  return new AppError(
    'VALIDATION_ERROR',
    'Unsupported image. Upload a JPEG, PNG or WebP photo (iPhone HEIC photos: share as JPEG).',
  );
}
