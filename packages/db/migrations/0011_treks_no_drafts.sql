-- Treks no longer have drafts: every trek with a destination is live (customers still only see
-- it once its organizer is approved and it has a published batch).
UPDATE "organizer_treks" SET "status" = 'published' WHERE "status" = 'draft' AND "catalog_trek_id" IS NOT NULL;
