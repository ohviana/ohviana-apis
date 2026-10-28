# Deploying Ohviana

Two Vercel projects, one per repository, and one database:

| Component                                      | What                                                       | Where                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Web** (ohviana-web)                          | Next.js marketplace + dashboards                           | Vercel project `ohviana-web`, `ohviana.com` (see that repository's README)    |
| **API** (`apps/api`, `dist/server.js`)         | Fastify REST API                                           | Vercel project `ohviana-apis`: a Fastify function, `api.ohviana.com`          |
| **Worker** (`apps/api`, `dist/worker/main.js`) | Outbox delivery (emails), maintenance, seat reconciliation | Same project: a Vercel Daemon (`Dockerfile.worker`), **1 instance is enough** |
| **Database**                                   | Supabase Postgres + Auth                                   | A **separate production** Supabase project (Mumbai)                           |

`vercel.json` declares the API service, the worker daemon and the Mumbai region (`bom1`). The
image in `apps/api/Dockerfile` still runs the API anywhere else (Render, Fly.io, a VM).

### The ohviana-apis Vercel project

- [ ] Vercel → **Add New → Project** → import `ohviana/ohviana-apis`. Leave **Root Directory**
      empty (the repository root, where `vercel.json` is) and the framework preset as detected.
- [ ] Add the environment variables below for **Production** (also Preview if you use previews:
      point those at a non-production database).
- [ ] Deploy. Production builds run `apps/api/scripts/vercel-build.sh`, which builds the API and
      then applies migrations through `MIGRATE_DATABASE_URL` before the new version goes live.
- [ ] **Settings → Domains**: add `api.ohviana.com` (and `api.ohviana.in` if wanted) and create the
      DNS record Vercel shows.
- [ ] Check `https://api.ohviana.com/v1/health/ready` and, in **Logs**, the worker's
      `worker started`. Daemons are in beta and run only for production deployments.
- [ ] Vercel refuses request bodies over 4.5 MB. The website shrinks larger photos before upload;
      other clients must stay under that size too.

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
- [ ] Use the Supabase **pooler** connection strings (IPv4), not the direct (IPv6-only) one:
      the transaction pooler (6543) for `DATABASE_URL`, the session pooler (5432) for migrations.

## 2. Environment variables

**API and worker**

| Variable                                       | Notes                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                     | `production`                                                                                                                                                                                                                                                                          |
| `AUTH_MODE`                                    | `supabase` (the temporary `dev` login is refused in production)                                                                                                                                                                                                                       |
| `AUTH_JWT_SECRET`                              | 32+ random characters; signs email + password sessions (keep secret)                                                                                                                                                                                                                  |
| `MIGRATE_DATABASE_URL`                         | Supabase **session pooler** URI (`pooler.supabase.com:5432`); production builds migrate through it                                                                                                                                                                                    |
| `DATABASE_URL`                                 | Supabase **transaction pooler** URI (`pooler.supabase.com:6543`) for API and worker. The session pooler (5432) allows only about 15 connections in total. Prepared statements are switched off automatically on 6543. Use the session pooler or direct URL when running `migrate.js`. |
| `DB_POOL_MAX`                                  | `3` on Vercel: every function instance opens its own pool; the worker uses 3. Keep the total within the pooler limit.                                                                                                                                                                 |
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
2. Merge to `main` in ohviana-apis. The Vercel production build **migrates first** (see above),
   then the API and worker go live. Migrations are additive; never edit an applied migration.
   Elsewhere, run `node dist/migrate.js` from the image before deploying.
3. Check `GET /v1/health/ready` returns `{"status":"ok"}` and the worker logs `worker started`
   and `maintenance done`.
4. Deploy web (ohviana-web) → open a trek page and a checkout.

Rollback: Vercel **Instant Rollback** (or redeploy the previous image/web build). Because migrations are additive, the previous
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
