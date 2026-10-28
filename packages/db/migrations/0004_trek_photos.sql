CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organizer_id" uuid,
	"content_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"thumb_bytes" "bytea" NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "trek_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organizer_trek_id" uuid NOT NULL,
	"organizer_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"category" text DEFAULT 'destination' NOT NULL,
	"caption" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trek_photos_category_ck" CHECK ("trek_photos"."category" in ('destination', 'trail', 'transport', 'stay', 'food', 'group', 'other')),
	CONSTRAINT "trek_photos_caption_ck" CHECK ("trek_photos"."caption" is null or length("trek_photos"."caption") <= 200)
);
--> statement-breakpoint
ALTER TABLE "trek_photos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_organizer_id_organizers_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."organizers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trek_photos" ADD CONSTRAINT "trek_photos_organizer_trek_id_organizer_treks_id_fk" FOREIGN KEY ("organizer_trek_id") REFERENCES "public"."organizer_treks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trek_photos" ADD CONSTRAINT "trek_photos_organizer_id_organizers_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."organizers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trek_photos" ADD CONSTRAINT "trek_photos_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_organizer_idx" ON "media" USING btree ("organizer_id");--> statement-breakpoint
CREATE INDEX "trek_photos_trek_idx" ON "trek_photos" USING btree ("organizer_trek_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "trek_photos_media_uq" ON "trek_photos" USING btree ("media_id");