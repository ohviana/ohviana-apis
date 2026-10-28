-- Every batch has its own booking link (new batches get one on create). Backfill the batches
-- that have no active link yet: 32 URL-safe characters from two random UUIDs.
INSERT INTO "direct_links" ("organizer_id", "batch_id", "token")
SELECT b."organizer_id", b."id",
  left(translate(encode(decode(
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
    'hex'), 'base64'), '+/=', '-_'), 32)
FROM "batches" b
WHERE b."status" IN ('draft', 'published')
  AND NOT EXISTS (
    SELECT 1 FROM "direct_links" l WHERE l."batch_id" = b."id" AND l."active"
  );
