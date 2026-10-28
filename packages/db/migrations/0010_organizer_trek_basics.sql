ALTER TABLE "organizer_treks" ADD COLUMN "difficulty" text;--> statement-breakpoint
ALTER TABLE "organizer_treks" ADD COLUMN "max_altitude_m" integer;--> statement-breakpoint
ALTER TABLE "organizer_treks" ADD COLUMN "start_point" text;--> statement-breakpoint
ALTER TABLE "organizer_treks" ADD CONSTRAINT "organizer_treks_difficulty_ck" CHECK ("organizer_treks"."difficulty" in ('easy', 'moderate', 'difficult', 'challenging'));--> statement-breakpoint
ALTER TABLE "organizer_treks" ADD CONSTRAINT "organizer_treks_altitude_ck" CHECK ("organizer_treks"."max_altitude_m" is null or "organizer_treks"."max_altitude_m" > 0);