# Deploying Ohviana

Three processes and one database:

| Component                                      | What                                                       | Suggested host                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Web** (`apps/web`)                           | Next.js marketplace + dashboards                           | Vercel (or any Node host: `npm run build && npm run start -w @ohviana/web`)        |
| **API** (`apps/api`, `dist/server.js`)         | Fastify REST API                                           | Render / Railway / Fly.io / a VM, from `apps/api/Dockerfile`                       |
| **Worker** (`apps/api`, `dist/worker/main.js`) | Outbox delivery (emails), maintenance, seat reconciliation | Same image as the API, second service, **1 instance is enough** (safe to run more) |
| **Database**                                   | Supabase Postgres + Auth                                   | A **separate production** Supabase project (Mumbai)                                |

## 1. One-time setup

- [ ] Create a **production Supabase project** (keep the current one for dev/tests — tests write
      and delete rows).
- [ ] Use a strong DB password (letters + digits avoids URL-encoding issues). Rotate the dev DB
      password too — it was shared during development.
- [ ] Supabase → **Authentication → URL Configuration**: Site URL = your web URL; Redirect URLs
      include `https://<web-domain>/**`.
- [ ] Supabase → **Authentication → Email**: configure custom SMTP (the built-in sender is
      limited to a few emails per hour).
- [ ] Email provider: create a Resend account, verify the sending domain, create an API key.
- [ ] Pick hosts with **IPv4**: use the Supabase **Session pooler** connection string
      (`…pooler.supabase.com:5432`), not the direct (IPv6-only) one.

## 2. Environment variables

**API and worker**

| Variable                                       | Notes                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                     | `production`                                                                                                                                                                                                                                                                          |
| `AUTH_MODE`                                    | `supabase` (the temporary `dev` login is refused in production)                                                                                                                                                                                                                       |
| `AUTH_JWT_SECRET`                              | 32+ random characters; signs email + password sessions (keep secret)                                                                                                                                                                                                                  |
| `DATABASE_URL`                                 | Supabase **transaction pooler** URI (`pooler.supabase.com:6543`) for API and worker. The session pooler (5432) allows only about 15 connections in total. Prepared statements are switched off automatically on 6543. Use the session pooler or direct URL when running `migrate.js`. |
| `DB_POOL_MAX`                                  | Per API instance (default 10); the worker uses 3. Keep the total within the pooler limit.                                                                                                                                                                                             |
| `SUPABASE_URL`                                 | `https://<ref>.supabase.co` (token verification via public JWKS — no secret)                                                                                                                                                                                                          |
| `CORS_ORIGINS`                                 | Web origin(s), e.g. `https://ohviana.in`                                                                                                                                                                                                                                              |
| `TRUST_PROXY`                                  | `true` behind the host's load balancer (correct client IPs for rate limits)                                                                                                                                                                                                           |
| `RATE_LIMIT_ENABLED` / `RATE_LIMIT_GLOBAL_MAX` | `true` / `300`                                                                                                                                                                                                                                                                        |
| `METRICS_TOKEN`                                | Random 32+ chars; Prometheus scrapes `/internal/metrics` with `x-metrics-token`                                                                                                                                                                                                       |
| `LOG_LEVEL`                                    | `info`                                                                                                                                                                                                                                                                                |
| `PUBLIC_SITE_URL` (worker)                     | Web URL used in emails                                                                                                                                                                                                                                                                |
| `RESEND_API_KEY`, `EMAIL_FROM` (worker)        | Without a key, emails are only logged                                                                                                                                                                                                                                                 |
| `ADMIN_NOTIFY_EMAIL` (worker)                  | Gets "new organizer" / "catalog request" notices                                                                                                                                                                                                                                      |

**Web** (build-time, public)

| Variable                               | Notes                                                   |
| -------------------------------------- | ------------------------------------------------------- |
| `NEXT_PUBLIC_API_BASE_URL`             | Public API URL                                          |
| `NEXT_PUBLIC_AUTH_MODE`                | `password` (email + password via the API) or `supabase` |
| `NEXT_PUBLIC_SITE_URL`                 | Public web URL (canonical URLs, sitemap, share links)   |
| `NEXT_PUBLIC_SUPABASE_URL`             | Supabase project URL                                    |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Publishable key (never the secret key)                  |

## 3. Every deploy

1. CI green (format, lint, typecheck, unit + integration tests, build, browser e2e).
2. **Migrate first**: `node dist/migrate.js` (from the image) against production. Migrations are
   additive; never edit an applied migration.
3. Deploy API → check `GET /v1/health/ready` returns `{"status":"ok"}`.
4. Deploy worker → logs show `worker started` and `maintenance done`.
5. Deploy web → open a trek page and a checkout.

Rollback: redeploy the previous image/web build. Because migrations are additive, the previous
version keeps working against the newer schema.

## 4. First production data

- [ ] Do **not** run `db:seed` (it refuses with `NODE_ENV=production`).
- [ ] Sign in once on the production site, then `npm run admin:grant -- you@example.com` with the
      production `DATABASE_URL`.
- [ ] Create the canonical catalog treks in **Admin → Catalog**; approve the pilot organizers.

## 5. Monitoring & alerts (TDD §7)

Scrape `/internal/metrics` and alert on:

| Signal               | Metric / log                                                        | Alert when                  |
| -------------------- | ------------------------------------------------------------------- | --------------------------- |
| API errors           | `http_requests_total{status=~"5.."}`                                | > 1% of requests over 5 min |
| Latency              | `http_request_duration_seconds`                                     | p95 > 1s for 10 min         |
| DB reachability      | `GET /v1/health/ready`                                              | non-200                     |
| Notifications stuck  | `outbox_events{state="oldest_pending_seconds"}`                     | > 600                       |
| Failed notifications | `outbox_events{state="dead"}`                                       | > 0                         |
| Inventory            | worker log `INVENTORY DISCREPANCY`                                  | any occurrence              |
| Abuse                | `http_requests_total{status="429"}`                                 | sudden spikes               |
| Funnel               | `bookings_created_total{source}`, `bookings_rejected_total{reason}` | dashboards (pilot metrics)  |

Dead-lettered outbox events (`available_at = 'infinity'`) are retried by resetting them:
`update outbox_events set attempts = 0, available_at = now() where id = '<id>';`

## 6. Security checklist

- [ ] RLS is enabled on every table (verified by `packages/db/test/schema.test.ts`); never add
      policies that expose tables to the Supabase REST API.
- [ ] Only the API/worker hold `DATABASE_URL`; the web app holds only public values.
- [ ] Backups: enable Supabase daily backups / PITR; do a restore drill before launch.
- [ ] Rate limits are per instance (in memory). With more than one API instance, configure a
      shared Redis store for `@fastify/rate-limit`.
- [ ] Review GST / e-commerce operator obligations before enabling payments (TDD §9).

## Known limits (MVP)

- **Trek photos are stored in Postgres** (`media` table, WebP ~100–300 KB each plus a thumbnail;
  up to 20 per trek) and served by the API with year-long caching. Fine for the pilot; at scale
  move the bytes to Supabase Storage / S3 behind a CDN (only `apps/api/src/modules/media/service.ts`
  changes) and watch the database size on the Supabase plan.

- Payments are out of scope: bookings confirm immediately; refunds are handled by organizers.
- Notifications are email only; SMS/WhatsApp can be added as another `Notifier`.
- Dashboard/admin screens have no automated browser tests (they need a real Supabase login);
  the APIs behind them are fully covered by integration tests.
