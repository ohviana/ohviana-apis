CREATE TABLE "organizer_lead_revocations" (
	"organizer_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizer_lead_revocations_organizer_id_phone_pk" PRIMARY KEY("organizer_id","phone")
);
--> statement-breakpoint
ALTER TABLE "organizer_lead_revocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organizer_members" DROP CONSTRAINT "organizer_members_role_ck";--> statement-breakpoint
-- Roles are now owner / co_owner / trek_lead: managers and staff become co-owners, and only the
-- earliest owner of each organizer stays owner (the rest become co-owners).
UPDATE "organizer_members" SET "role" = 'co_owner' WHERE "role" IN ('manager', 'staff');--> statement-breakpoint
UPDATE "organizer_members" m SET "role" = 'co_owner'
WHERE m."role" = 'owner' AND EXISTS (
  SELECT 1 FROM "organizer_members" o
  WHERE o."organizer_id" = m."organizer_id" AND o."role" = 'owner'
    AND (o."created_at", o."user_id") < (m."created_at", m."user_id")
);--> statement-breakpoint
ALTER TABLE "organizer_lead_revocations" ADD CONSTRAINT "organizer_lead_revocations_organizer_id_organizers_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."organizers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizer_lead_revocations" ADD CONSTRAINT "organizer_lead_revocations_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organizer_members_one_owner_uq" ON "organizer_members" USING btree ("organizer_id") WHERE "organizer_members"."role" = 'owner';--> statement-breakpoint
CREATE INDEX "batches_leads_idx" ON "batches" USING gin ("leads" jsonb_path_ops);--> statement-breakpoint
ALTER TABLE "organizer_members" ADD CONSTRAINT "organizer_members_role_ck" CHECK ("organizer_members"."role" in ('owner', 'co_owner', 'trek_lead'));