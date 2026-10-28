ALTER TABLE "booking_guests" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Existing travellers keep the order they were shown in (alphabetical).
UPDATE "booking_guests" g SET "position" = o.n
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "booking_id" ORDER BY "full_name") - 1 AS n
  FROM "booking_guests"
) o WHERE o."id" = g."id";
