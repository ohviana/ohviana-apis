CREATE TABLE "phone_otps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_otps_attempts_ck" CHECK ("phone_otps"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "phone_otps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "phone_otps_phone_created_idx" ON "phone_otps" USING btree ("phone","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "users_phone_idx" ON "users" USING btree ("phone");