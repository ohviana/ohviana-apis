CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_guest_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"organizer_id" uuid NOT NULL,
	"author_id" uuid,
	"author_name" text NOT NULL,
	"overall" smallint NOT NULL,
	"stay" smallint,
	"bus" smallint,
	"food" smallint,
	"leader" smallint,
	"safety" smallint,
	"comment" text,
	"reply" text,
	"replied_at" timestamp with time zone,
	"replied_by" uuid,
	"hidden_at" timestamp with time zone,
	"hidden_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_overall_ck" CHECK ("reviews"."overall" between 1 and 5),
	CONSTRAINT "reviews_aspects_ck" CHECK (("reviews"."stay" is null or "reviews"."stay" between 1 and 5) and ("reviews"."bus" is null or "reviews"."bus" between 1 and 5)
          and ("reviews"."food" is null or "reviews"."food" between 1 and 5) and ("reviews"."leader" is null or "reviews"."leader" between 1 and 5)
          and ("reviews"."safety" is null or "reviews"."safety" between 1 and 5)),
	CONSTRAINT "reviews_comment_ck" CHECK (char_length("reviews"."comment") <= 1000),
	CONSTRAINT "reviews_reply_ck" CHECK (char_length("reviews"."reply") <= 1000),
	CONSTRAINT "reviews_replied_ck" CHECK (("reviews"."reply" is null) = ("reviews"."replied_at" is null))
);
--> statement-breakpoint
ALTER TABLE "reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_booking_guest_id_booking_guests_id_fk" FOREIGN KEY ("booking_guest_id") REFERENCES "public"."booking_guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_organizer_id_organizers_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."organizers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_replied_by_users_id_fk" FOREIGN KEY ("replied_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_hidden_by_users_id_fk" FOREIGN KEY ("hidden_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_guest_uq" ON "reviews" USING btree ("booking_guest_id");--> statement-breakpoint
CREATE INDEX "reviews_organizer_idx" ON "reviews" USING btree ("organizer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reviews_booking_idx" ON "reviews" USING btree ("booking_id");