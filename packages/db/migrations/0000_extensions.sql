-- Extensions live in the `extensions` schema (Supabase convention; created here for plain Postgres).
CREATE SCHEMA IF NOT EXISTS extensions;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
