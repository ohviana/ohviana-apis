# Ohviana MVP — Delivery Phases

Source: `Ohviana_-_PRD.pdf`, `Ohviana_-_TDD.pdf`.

**Scope decision:** payments are out of scope. A successful reservation creates a
`confirmed` booking immediately (seats move straight to `confirmed_seats`). The booking
status model is kept extensible so a payment step (`held` → `confirmed`) can be added later.

| #   | Phase                | Deliverables                                                                                                                                                          | Status  |
| --- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | Foundation           | npm-workspaces monorepo, TS, ESLint/Prettier, CI, Fastify API skeleton (config, error envelope, request IDs, PII-redacted logs, OpenAPI), Next.js skeleton            | ✅ Done |
| 2   | Database             | `packages/db` with Drizzle schema + SQL migrations (incl. review fixes: pickups, policy & commission snapshots, organizer statuses, catalog requests), seed, Supabase | ✅ Done |
| 3   | Auth & RBAC          | Supabase JWT verification, user sync, organizer-membership & admin guards                                                                                             | ✅ Done |
| 4   | Admin & catalog      | Catalog trek CRUD, organizer approve/reject/suspend, catalog requests                                                                                                 | ✅ Done |
| 5   | Organizer domain     | Registration, profile, members, trek templates, pickup points, batch CRUD & lifecycle                                                                                 | ✅ Done |
| 6   | Public discovery API | Trek/organizer search, date filters, batch comparison, trigram search                                                                                                 | ✅ Done |
| 7   | Booking engine       | Row-locked reservations, idempotency, direct-link attribution, commission snapshot, cancellations, audit + outbox                                                     | ✅ Done |
| 8   | Web: marketplace     | Home, search, trek/organizer pages, checkout, confirmation                                                                                                            | ✅ Done |
| 9   | Web: dashboards      | Organizer dashboard, admin console                                                                                                                                    | ✅ Done |
| 10  | Hardening            | Notification worker, SEO, rate limits, observability, e2e + last-seat load tests                                                                                      | ✅ Done |

## Phase 2 notes

- Database: a Supabase project in Mumbai (ap-south-1), via the Session pooler.
- 17 tables, RLS enabled on all. Payments tables intentionally omitted.
- Review fixes included: pickup points per template + per-batch pickup times, organizer
  `rejected` status + review fields, catalog trek requests, organizer-level direct links,
  booking contact/emergency/guest details, policy and commission snapshots, idempotency keys,
  outbox retries, admin audit log, composite FKs for tenant consistency.
- User sync with `auth.users` was handled in Phase 3 (API-side, see below).

## Phase 3 notes

- Access tokens verified against the Supabase project's JWKS (ES256); issuer, audience
  (`authenticated`), expiry, role and non-anonymous checked. Any invalid token is a 401, even
  on public routes.
- `public.users` is upserted from token claims on authenticated requests (cached 10 min);
  profile edits via `PATCH /v1/me` are never overwritten by claims. No DB trigger on
  `auth.users`, so it works identically on Supabase and plain Postgres (CI).
- Guards: `app.guards.user`, `app.guards.admin`, `app.guards.organizer(permission)`.
  Permission matrix lives in `@ohviana/shared` (`ROLE_PERMISSIONS`, `statusAllowsPermission`).
  Active organizer = `x-organizer-id` header, or the caller's only membership.
- Admin bootstrap: `npm run admin:grant -- <email>` (audited in `admin_audit_log`).
- Temporary `/login` (magic link) and `/account` pages in the web app to exercise real auth.

## Phase 4 notes

- Admin API under `/v1/admin` (guard applied to the whole scope): catalog trek CRUD + search,
  organizer review (approve with commission / reject / suspend / reinstate / commission change),
  catalog request approve (link existing or create new; auto-links waiting draft templates) /
  reject, and the audit log.
- Organizer lifecycle: pending → approved | rejected; rejected → approved; approved → suspended;
  suspended → approved. Transitions are conditional UPDATEs, so concurrent reviews can't both win.
- Every admin mutation writes `admin_audit_log` in the same transaction; organizer and catalog
  request decisions also enqueue an outbox event (delivered by the Phase 10 worker).
- Keyset (cursor) pagination for every list; LIKE wildcards in search are escaped.
- Guards now run at `onRequest`, before body validation, so unauthorized callers get 401/403
  rather than schema details.
- API tests clean up everything they create; verified zero residue after a full run.

## Phase 5 notes

- `POST /v1/organizers` registers a pending organizer (caller = owner, max 5 owned per account,
  admins notified via outbox). Everything else lives under `/v1/organizer` and acts on the
  active organizer (`x-organizer-id`, or the caller's only membership).
- Profile (slug frozen after approval), members (add existing users by email; the last owner can
  never be removed or demoted — owner rows are locked during changes), catalog search and
  catalog requests, trek templates (+ pickup points), batches, direct links, dashboard summary.
- New permission `batches:publish`: only approved organizers can make batches bookable;
  pending organizers can still prepare templates and draft batches.
- Batch rules: departure/cutoff must be in the future and cutoff ≤ departure; bulk creation is
  all-or-nothing; dates are frozen once seats are sold; capacity can't drop below sold seats;
  price changes affect new bookings only; ended/cancelled batches are frozen; only drafts can be
  deleted; cancelling a published batch cancels its bookings atomically, writes
  `booking_events` and enqueues `batch.cancelled`.
- Dashboard views (draft, upcoming, sold_out, booking_closed, ongoing, completed, cancelled) are
  derived; `batchViewSql` (SQL) mirrors `deriveBatchView` (TS).
- Direct-link tokens are 192-bit random, URL-safe; organizer-wide (`batchId` null) or per batch.
  Booking attribution through them arrives with the booking engine in Phase 7.

## Phase 6 notes

- Anonymous endpoints: `GET /v1/treks`, `/v1/treks/{slug}`, `/v1/treks/{slug}/batches`,
  `/v1/organizers`, `/v1/organizers/{slug}`, `/v1/organizers/{slug}/batches`,
  `/v1/batches/{id}`, `/v1/direct/{token}`.
- One visibility rule (`modules/public/visibility.ts`): batch published and departing in the
  window, organizer approved, template and catalog trek published. Lists default to bookable
  only (seats left, cutoff open); `includeUnavailable=true` adds sold-out/closed for comparison.
- Dates are IST calendar days (`from`/`to`, max 366 days); the window never starts in the past.
- Trek search: substring + trigram word similarity (typos), district, difficulty; each result
  carries availability (departures, organizers, min price, next departure) for the window.
  With dates, only treks that have departures in the window are returned.
- Batch lists sort by `departure_asc` or `price_asc` with keyset cursors.
- Direct links: inactive/expired/unknown/unapproved all return the same 404; responses are
  `private, no-store` and `X-Robots-Tag: noindex`. Other anonymous reads are shared-cacheable
  for 30s (`private, no-store` when a token is sent). Private organizer fields (contact, GSTIN)
  are never exposed.

## Phase 7 notes

- `POST /v1/bookings` (guest or signed in, `Idempotency-Key` required) runs in one transaction:
  claim the key → lock the batch row (`FOR UPDATE OF batches`) → validate visibility, cutoff
  (422 `BOOKING_CUTOFF`), per-booking max, seats (409 `SOLD_OUT`), pickup → resolve attribution
  server-side → price + commission snapshot → insert booking/guests → bump `confirmed_seats` →
  `booking_events` + outbox `booking.confirmed`.
- Idempotency: same key + same body replays the booking (`idempotent-replayed: true`); different
  body → 409 `IDEMPOTENCY_CONFLICT`; concurrent duplicates serialize on the key and replay;
  failures are not remembered (the claim rolls back); keys expire after 24h.
- Attribution: a valid, active, unexpired direct-link token for this organizer (and batch, if
  batch-scoped) → `ORGANIZER_DIRECT`, 0% commission; otherwise `MARKETPLACE` at the organizer's
  agreed rate. An invalid token is rejected (400) rather than silently ignored.
- Guest access: a random access token is returned once at booking; only its SHA-256 is stored
  (replays issue a fresh one). `GET/POST /v1/bookings/{ref}[/cancel]` accept the signed-in owner
  or `x-booking-token`; everyone else gets 404.
- Cancellation (customer or organizer) before departure releases seats; lock order is always
  batch → booking (same as creation and batch cancellation) to avoid deadlocks.
- Organizer: `GET /v1/organizer/batches/{id}/bookings`, `/attendees.csv` (formula-injection safe,
  UTF-8 BOM, IST times), `GET/POST /v1/organizer/bookings/{ref}[/cancel]`.
- Commission is visible to organizers only, never in customer responses.
- Verified: 10 concurrent requests for 3 seats → exactly 3 bookings; 5 concurrent duplicates →
  1 booking (stable over repeated runs).
- Migration `0002_booking_access_token` adds `bookings.access_token_hash`.

## Phase 8 notes

- Pages: `/`, `/search`, `/treks/[slug]` (departure comparison), `/organizers/[slug]`,
  `/batches/[id]`, `/book/[batchId]` (checkout), `/bookings/[reference]`, `/b/[token]`
  (direct link), `/my-bookings`; plus `robots.txt`, `sitemap.xml`, not-found and error pages.
- Server components fetch the public API (validated against contracts; 30–60s revalidation);
  checkout, confirmation and My bookings are client components.
- Search and filter forms are plain GET forms (work without JS, shareable URLs).
- SEO: trek and organizer pages are indexable with canonical URLs and descriptions; search,
  departure, checkout, booking and direct-link pages are `noindex`. `NEXT_PUBLIC_SITE_URL`
  sets absolute URLs.
- Checkout: one Idempotency-Key per distinct form body (a retried/double-tapped submit can't
  double-book; editing the form starts a new attempt). 10-digit Indian mobiles are normalised to
  E.164. The direct-link token travels as `?via=` to checkout; the API decides attribution.
- Guest booking access: the token is stored in this browser and also passed once in the URL
  fragment (never sent to servers), then removed from the address bar.
- All times shown in IST regardless of device time zone.
- Not yet covered by automated browser tests (planned for Phase 10 with Playwright).

## Phase 9 notes

- Organizer dashboard (`/dashboard`): overview (status banner incl. admin review note, batch
  counts per view, booking totals split marketplace/direct), batches (view tabs, publish,
  delete drafts), batch detail (edit with IST date-times and rupee prices, pickup times,
  bookings/attendees, CSV download, cancel batch or single bookings, create share link),
  treks (create, catalog search or catalog request, itinerary/inclusions as one-per-line,
  publish/archive, pickup points, single or weekly batch creation), direct links (create,
  copy URL, deactivate), team, profile. Users with no organizer see registration.
- Multiple organizers: switcher in the sidebar; the choice is remembered and sent as
  `x-organizer-id`.
- Admin console (`/admin`): overview counts, organizers (status tabs, search, approve with
  commission %, reject/suspend with reason, reinstate, change commission, private details),
  catalog requests (approve as new trek or link existing; reject), catalog (create/edit,
  per-trek change history), audit log.
- The UI mirrors API permissions (`roleHasPermission`/`statusAllowsPermission`) only to hide
  actions; the API remains the authority. All console pages are `noindex`.
- Verified statically that all 67 API calls made by the web app match real API routes and
  methods (checked against the live OpenAPI spec).

## Phase 10 notes

- Outbox worker (`apps/api/src/worker`, `npm run dev:worker`): claims due events with
  `FOR UPDATE SKIP LOCKED` + a 5-minute lease (safe with several workers), delivers via a
  `Notifier` (Resend when `RESEND_API_KEY` is set, otherwise logs), retries with exponential
  backoff (30s → 1h), dead-letters after 8 attempts (`available_at = 'infinity'`). At-least-once.
  Emails: booking confirmed/cancelled (customer + organizer), batch cancelled, organizer
  approved/rejected/suspended, catalog request decisions, admin notices.
- Maintenance every 15 min: purge expired idempotency keys and old delivered outbox rows;
  **seat reconciliation** (counter vs bookings) logs `INVENTORY DISCREPANCY` on mismatch.
- Rate limiting (`@fastify/rate-limit`, per IP, in memory): global 300/min; bookings 20/min;
  organizer registration 5/hour; search 120/min. Runs before auth guards so anonymous floods
  are counted; `TRUST_PROXY` for real client IPs. Standard `RATE_LIMITED` envelope +
  `retry-after`.
- Metrics (`GET /internal/metrics`, `x-metrics-token`): request count/latency by route pattern,
  `bookings_created_total{source}`, `bookings_rejected_total{reason}`, outbox backlog/dead,
  Node process metrics.
- Web security headers: X-Frame-Options, nosniff, Referrer-Policy (keeps `?via=` tokens
  same-origin), Permissions-Policy, HSTS.
- Playwright e2e (`npm run e2e`; desktop + Pixel 7): marketplace journey (typo search → compare
  → sort → checkout → confirmation → reload → cancel), direct-link journey (commission-free),
  checkout validation, dead link, SEO tags. Tests remove their bookings and restore seats.
  Found and fixed: confirmation banner lost under React's double effects.
- Deployment: `apps/api/Dockerfile` (API, worker and `dist/migrate.js` in one image),
  `docs/DEPLOYMENT.md`, CI e2e job against a throwaway seeded Postgres.
