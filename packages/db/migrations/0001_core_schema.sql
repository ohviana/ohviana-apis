CREATE TABLE "admin_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "platform_admins" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_admins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text,
	"full_name" text,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organizer_members" (
	"organizer_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizer_members_organizer_id_user_id_pk" PRIMARY KEY("organizer_id","user_id"),
	CONSTRAINT "organizer_members_role_ck" CHECK ("organizer_members"."role" in ('owner', 'manager', 'staff'))
);
--> statement-breakpoint
ALTER TABLE "organizer_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organizers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tagline" text,
	"description" text,
	"logo_url" text,
	"city" text,
	"contact_email" text,
	"contact_phone" text,
	"gstin" text,
	"commission_rate_bps" integer DEFAULT 0 NOT NULL,
	"verification_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"review_note" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizers_status_ck" CHECK ("organizers"."status" in ('pending', 'approved', 'rejected', 'suspended')),
	CONSTRAINT "organizers_slug_ck" CHECK ("organizers"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "organizers_commission_ck" CHECK ("organizers"."commission_rate_bps" between 0 and 10000)
);
--> statement-breakpoint
ALTER TABLE "organizers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog_trek_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organizer_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"name" text NOT NULL,
	"state" text,
	"region" text,
	"district" text,
	"notes" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"catalog_trek_id" uuid,
	"review_note" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_trek_requests_status_ck" CHECK ("catalog_trek_requests"."status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "catalog_trek_requests_approved_ck" CHECK ("catalog_trek_requests"."status" <> 'approved' or "catalog_trek_requests"."catalog_trek_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "catalog_trek_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog_treks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"state" text,
	"region" text,
	"district" text,
	"difficulty" text,
	"summary" text,
	"description" text,
	"max_altitude_m" integer,
	"hero_image_url" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_treks_status_ck" CHECK ("catalog_treks"."status" in ('draft', 'published', 'archived')),
	CONSTRAINT "catalog_treks_difficulty_ck" CHECK ("catalog_treks"."difficulty" in ('easy', 'moderate', 'difficult', 'challenging')),
	CONSTRAINT "catalog_treks_slug_ck" CHECK ("catalog_treks"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "catalog_treks_altitude_ck" CHECK ("catalog_treks"."max_altitude_m" is null or "catalog_treks"."max_altitude_m" > 0)
);
--> statement-breakpoint
ALTER TABLE "catalog_treks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organizer_treks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organizer_id" uuid NOT NULL,
	"catalog_trek_id" uuid,
	"catalog_trek_request_id" uuid,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"summary" text,
	"duration_days" integer,
	"itinerary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inclusions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exclusions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"things_to_carry" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cancellation_policy" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizer_treks_id_org_uq" UNIQUE("id","organizer_id"),
	CONSTRAINT "organizer_treks_status_ck" CHECK ("organizer_treks"."status" in ('draft', 'published', 'archived')),
	CONSTRAINT "organizer_treks_slug_ck" CHECK ("organizer_treks"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "organizer_treks_catalog_required_ck" CHECK ("organizer_treks"."status" = 'draft' or "organizer_treks"."catalog_trek_id" is not null),
	CONSTRAINT "organizer_treks_duration_ck" CHECK ("organizer_treks"."duration_days" is null or "organizer_treks"."duration_days" > 0)
);
--> statement-breakpoint
ALTER TABLE "organizer_treks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pickup_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organizer_trek_id" uuid NOT NULL,
	"organizer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"landmark" text,
	"maps_url" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pickup_points_id_trek_uq" UNIQUE("id","organizer_trek_id")
);
--> statement-breakpoint
ALTER TABLE "pickup_points" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "batch_pickups" (
	"batch_id" uuid NOT NULL,
	"pickup_point_id" uuid NOT NULL,
	"organizer_trek_id" uuid NOT NULL,
	"pickup_at" timestamp with time zone NOT NULL,
	CONSTRAINT "batch_pickups_batch_id_pickup_point_id_pk" PRIMARY KEY("batch_id","pickup_point_id")
);
--> statement-breakpoint
ALTER TABLE "batch_pickups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organizer_trek_id" uuid NOT NULL,
	"organizer_id" uuid NOT NULL,
	"departure_at" timestamp with time zone NOT NULL,
	"return_at" timestamp with time zone NOT NULL,
	"booking_cutoff_at" timestamp with time zone NOT NULL,
	"price_paise" bigint NOT NULL,
	"capacity" integer NOT NULL,
	"confirmed_seats" integer DEFAULT 0 NOT NULL,
	"max_seats_per_booking" integer DEFAULT 10 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"published_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batches_id_org_uq" UNIQUE("id","organizer_id"),
	CONSTRAINT "batches_id_trek_uq" UNIQUE("id","organizer_trek_id"),
	CONSTRAINT "batches_status_ck" CHECK ("batches"."status" in ('draft', 'published', 'cancelled', 'completed')),
	CONSTRAINT "batches_dates_ck" CHECK ("batches"."return_at" > "batches"."departure_at"),
	CONSTRAINT "batches_cutoff_ck" CHECK ("batches"."booking_cutoff_at" <= "batches"."departure_at"),
	CONSTRAINT "batches_price_ck" CHECK ("batches"."price_paise" >= 0),
	CONSTRAINT "batches_capacity_ck" CHECK ("batches"."capacity" > 0),
	CONSTRAINT "batches_seats_ck" CHECK ("batches"."confirmed_seats" >= 0 and "batches"."confirmed_seats" <= "batches"."capacity"),
	CONSTRAINT "batches_max_per_booking_ck" CHECK ("batches"."max_seats_per_booking" > 0)
);
--> statement-breakpoint
ALTER TABLE "batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "direct_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organizer_id" uuid NOT NULL,
	"batch_id" uuid,
	"token" text NOT NULL,
	"label" text,
	"active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "direct_links_token_ck" CHECK (length("direct_links"."token") >= 16)
);
--> statement-breakpoint
ALTER TABLE "direct_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "booking_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "booking_guests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"phone" text,
	"age" integer,
	"gender" text,
	CONSTRAINT "booking_guests_age_ck" CHECK ("booking_guests"."age" is null or "booking_guests"."age" between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "booking_guests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_reference" text NOT NULL,
	"batch_id" uuid NOT NULL,
	"organizer_id" uuid NOT NULL,
	"user_id" uuid,
	"source" text NOT NULL,
	"direct_link_id" uuid,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"commission_rate_bps" integer NOT NULL,
	"commission_paise" bigint NOT NULL,
	"commission_snapshot" jsonb NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"pickup_point_id" uuid,
	"contact_name" text NOT NULL,
	"contact_phone" text NOT NULL,
	"contact_email" text,
	"emergency_contact_name" text,
	"emergency_contact_phone" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_source_ck" CHECK ("bookings"."source" in ('MARKETPLACE', 'ORGANIZER_DIRECT')),
	CONSTRAINT "bookings_status_ck" CHECK ("bookings"."status" in ('confirmed', 'cancelled')),
	CONSTRAINT "bookings_quantity_ck" CHECK ("bookings"."quantity" > 0),
	CONSTRAINT "bookings_unit_price_ck" CHECK ("bookings"."unit_price_paise" >= 0),
	CONSTRAINT "bookings_total_ck" CHECK ("bookings"."total_paise" = "bookings"."unit_price_paise" * "bookings"."quantity"),
	CONSTRAINT "bookings_commission_ck" CHECK ("bookings"."commission_paise" >= 0 and "bookings"."commission_paise" <= "bookings"."total_paise"
          and "bookings"."commission_rate_bps" between 0 and 10000),
	CONSTRAINT "bookings_direct_zero_commission_ck" CHECK ("bookings"."source" <> 'ORGANIZER_DIRECT' or ("bookings"."commission_paise" = 0 and "bookings"."commission_rate_bps" = 0)),
	CONSTRAINT "bookings_direct_link_ck" CHECK (("bookings"."source" = 'ORGANIZER_DIRECT') = ("bookings"."direct_link_id" is not null)),
	CONSTRAINT "bookings_cancel_ck" CHECK (("bookings"."status" = 'cancelled') = ("bookings"."cancelled_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "bookings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizer_members" ADD CONSTRAINT "organizer_members_organizer_id_organizers_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."organizers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizer_members" ADD CONSTRAINT "organizer_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizers" ADD CONSTRAINT "organizers_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_trek_requests" ADD CONSTRAINT "catalog_trek_requests_organizer_id_organizers_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."organizers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_trek_requests" ADD CONSTRAINT "catalog_trek_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_trek_requests" ADD CONSTRAINT "catalog_trek_requests_catalog_trek_id_catalog_treks_id_fk" FOREIGN KEY ("catalog_trek_id") REFERENCES "public"."catalog_treks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_trek_requests" ADD CONSTRAINT "catalog_trek_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizer_treks" ADD CONSTRAINT "organizer_treks_organizer_id_organizers_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."organizers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizer_treks" ADD CONSTRAINT "organizer_treks_catalog_trek_id_catalog_treks_id_fk" FOREIGN KEY ("catalog_trek_id") REFERENCES "public"."catalog_treks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizer_treks" ADD CONSTRAINT "organizer_treks_catalog_trek_request_id_catalog_trek_requests_id_fk" FOREIGN KEY ("catalog_trek_request_id") REFERENCES "public"."catalog_trek_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_points" ADD CONSTRAINT "pickup_points_trek_fk" FOREIGN KEY ("organizer_trek_id","organizer_id") REFERENCES "public"."organizer_treks"("id","organizer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_pickups" ADD CONSTRAINT "batch_pickups_batch_fk" FOREIGN KEY ("batch_id","organizer_trek_id") REFERENCES "public"."batches"("id","organizer_trek_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_pickups" ADD CONSTRAINT "batch_pickups_point_fk" FOREIGN KEY ("pickup_point_id","organizer_trek_id") REFERENCES "public"."pickup_points"("id","organizer_trek_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_trek_fk" FOREIGN KEY ("organizer_trek_id","organizer_id") REFERENCES "public"."organizer_treks"("id","organizer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_links" ADD CONSTRAINT "direct_links_organizer_id_organizers_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."organizers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_links" ADD CONSTRAINT "direct_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_links" ADD CONSTRAINT "direct_links_batch_fk" FOREIGN KEY ("batch_id","organizer_id") REFERENCES "public"."batches"("id","organizer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_guests" ADD CONSTRAINT "booking_guests_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_direct_link_id_direct_links_id_fk" FOREIGN KEY ("direct_link_id") REFERENCES "public"."direct_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_batch_fk" FOREIGN KEY ("batch_id","organizer_id") REFERENCES "public"."batches"("id","organizer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_pickup_fk" FOREIGN KEY ("batch_id","pickup_point_id") REFERENCES "public"."batch_pickups"("batch_id","pickup_point_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_entity_idx" ON "admin_audit_log" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "organizer_members_user_idx" ON "organizer_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizers_slug_uq" ON "organizers" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "organizers_status_idx" ON "organizers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "organizers_name_trgm_idx" ON "organizers" USING gin ("name" extensions.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "catalog_trek_requests_status_idx" ON "catalog_trek_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "catalog_trek_requests_org_idx" ON "catalog_trek_requests" USING btree ("organizer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_treks_slug_uq" ON "catalog_treks" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "catalog_treks_status_idx" ON "catalog_treks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "catalog_treks_name_trgm_idx" ON "catalog_treks" USING gin ("name" extensions.gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "organizer_treks_org_slug_uq" ON "organizer_treks" USING btree ("organizer_id","slug");--> statement-breakpoint
CREATE INDEX "organizer_treks_catalog_idx" ON "organizer_treks" USING btree ("catalog_trek_id","status");--> statement-breakpoint
CREATE INDEX "pickup_points_trek_idx" ON "pickup_points" USING btree ("organizer_trek_id","sort_order");--> statement-breakpoint
CREATE INDEX "batches_departure_idx" ON "batches" USING btree ("status","departure_at");--> statement-breakpoint
CREATE INDEX "batches_trek_idx" ON "batches" USING btree ("organizer_trek_id","departure_at");--> statement-breakpoint
CREATE INDEX "batches_org_idx" ON "batches" USING btree ("organizer_id","departure_at");--> statement-breakpoint
CREATE UNIQUE INDEX "direct_links_token_uq" ON "direct_links" USING btree ("token");--> statement-breakpoint
CREATE INDEX "direct_links_org_idx" ON "direct_links" USING btree ("organizer_id","active");--> statement-breakpoint
CREATE INDEX "booking_events_booking_idx" ON "booking_events" USING btree ("booking_id","created_at");--> statement-breakpoint
CREATE INDEX "booking_guests_booking_idx" ON "booking_guests" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_reference_uq" ON "bookings" USING btree ("booking_reference");--> statement-breakpoint
CREATE INDEX "bookings_batch_status_idx" ON "bookings" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX "bookings_org_created_idx" ON "bookings" USING btree ("organizer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "bookings_user_idx" ON "bookings" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox_events" USING btree ("available_at") WHERE "outbox_events"."processed_at" is null;