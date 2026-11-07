ALTER TABLE "users" ADD COLUMN "auth_user_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "users_auth_user_id_uq" ON "users" USING btree ("auth_user_id");