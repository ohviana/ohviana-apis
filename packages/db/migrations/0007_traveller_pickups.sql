ALTER TABLE "booking_guests" ADD COLUMN "pickup_point_id" uuid;--> statement-breakpoint
ALTER TABLE "booking_guests" ADD CONSTRAINT "booking_guests_pickup_point_id_pickup_points_id_fk" FOREIGN KEY ("pickup_point_id") REFERENCES "public"."pickup_points"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Existing travellers board where their booking boards.
UPDATE "booking_guests" g SET "pickup_point_id" = b."pickup_point_id"
FROM "bookings" b WHERE b."id" = g."booking_id" AND g."pickup_point_id" IS NULL;
--> statement-breakpoint
-- The traveller who is the booking contact is reachable on the contact's number.
UPDATE "booking_guests" g SET "phone" = b."contact_phone"
FROM "bookings" b
WHERE b."id" = g."booking_id" AND g."phone" IS NULL
  AND lower(trim(g."full_name")) = lower(trim(b."contact_name"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "booking_guests_pickup_idx" ON "booking_guests" ("pickup_point_id");
