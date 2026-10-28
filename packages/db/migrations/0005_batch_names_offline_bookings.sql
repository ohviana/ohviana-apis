ALTER TABLE "bookings" DROP CONSTRAINT "bookings_source_ck";--> statement-breakpoint
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_direct_zero_commission_ck";--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "name" text;--> statement-breakpoint
-- Name existing batches like new ones (shared/text.ts batchName): Org_Place_25th_Sept_Batch_1.
CREATE FUNCTION pg_temp.ohv_name_part(t text, max_len int) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(nullif(rtrim(left(string_agg(upper(left(w, 1)) || substr(w, 2), '_' ORDER BY i), max_len), '_'), ''), 'Trek')
  FROM regexp_split_to_table(t, '[^A-Za-z0-9]+') WITH ORDINALITY AS s(w, i)
  WHERE w <> ''
$$;--> statement-breakpoint
UPDATE "batches" b SET "name" = n.name
FROM (
  SELECT b2.id,
    pg_temp.ohv_name_part(o.name, 40) || '_' ||
    pg_temp.ohv_name_part(coalesce(c.name, t.title), 60) || '_' ||
    to_char(b2.departure_at AT TIME ZONE 'Asia/Kolkata', 'FMDDth') || '_' ||
    (ARRAY['Jan','Feb','Mar','Apr','May','June','July','Aug','Sept','Oct','Nov','Dec'])[extract(month FROM b2.departure_at AT TIME ZONE 'Asia/Kolkata')::int] ||
    '_Batch_' ||
    row_number() OVER (
      PARTITION BY b2.organizer_id, b2.organizer_trek_id, (b2.departure_at AT TIME ZONE 'Asia/Kolkata')::date
      ORDER BY b2.created_at, b2.id
    ) AS name
  FROM "batches" b2
  JOIN "organizers" o ON o.id = b2.organizer_id
  JOIN "organizer_treks" t ON t.id = b2.organizer_trek_id
  LEFT JOIN "catalog_treks" c ON c.id = t.catalog_trek_id
) n
WHERE n.id = b.id;--> statement-breakpoint
-- Two treks with the same destination on the same day would collide: number the duplicates on.
UPDATE "batches" b SET "name" = b."name" || '_' || d.k
FROM (
  SELECT id, row_number() OVER (PARTITION BY organizer_id, name ORDER BY created_at, id) AS k
  FROM "batches"
) d
WHERE d.id = b.id AND d.k > 1;--> statement-breakpoint
ALTER TABLE "batches" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "batches_org_name_uq" ON "batches" USING btree ("organizer_id","name");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_source_ck" CHECK ("bookings"."source" in ('MARKETPLACE', 'ORGANIZER_DIRECT', 'ORGANIZER_OFFLINE'));--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_direct_zero_commission_ck" CHECK ("bookings"."source" = 'MARKETPLACE' or ("bookings"."commission_paise" = 0 and "bookings"."commission_rate_bps" = 0));
