# Ohviana MVP — Project Review (Phases 1–10)

_Review date: 16 October 2026 · Sources: `Ohviana_-_PRD.pdf`, `Ohviana_-_TDD.pdf`, this repository_

This document looks back over all ten delivery phases: what each phase set out to do, what was
built, how it was verified, what went wrong and was fixed, and what is still open. It ends with a
check against the PRD acceptance criteria, the status of the findings from the original PRD/TDD
review, a ranked list of risks, and an overall conclusion.

---

## 1. Executive summary

**Verdict: the MVP is functionally complete and well-tested, and ready for an internal / pilot
deployment after a short list of pre-launch actions (section 7).** It is not yet ready for an open
public launch, mainly because bookings are free and unverified (no payment, no phone check), which
lets anyone reserve seats they don't intend to use.

What exists today:

- A customer marketplace: search treks (typo-tolerant, optional dates), compare dated departures
  across organizers, book as a guest or signed-in user, view and cancel bookings.
- Organizer direct booking links with server-decided, commission-free attribution.
- An organizer dashboard (treks, batches, pickups, attendees + CSV, links, team, profile) and an
  admin console (organizer review, catalog, catalog requests, audit log).
- A booking engine that cannot oversell, cannot double-book on retries, and snapshots price,
  commission and cancellation policy.
- Email notifications via an outbox worker, rate limiting, metrics, security headers, browser
  tests on desktop and mobile, a Dockerfile, CI and a deployment guide.

**Scope decision carried throughout:** payments were left out at your request. A booking is
`confirmed` immediately; the schema keeps room to add a payment step later.

### At a glance

| Measure                               | Value                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| API endpoints                         | **65** (public 8 · bookings 4 · me 2 · organizer 34 · admin 15 · system 2)       |
| Database                              | **17 tables**, 3 migrations, Row Level Security on every table                   |
| Web pages                             | **25** (marketplace, checkout, bookings, organizer dashboard, admin console)     |
| Source code                           | ~13,400 lines (API 5.7k · web 5.6k · db 1.1k · contracts 0.9k · shared 0.2k)     |
| Automated tests                       | **231** unit/integration + **10** browser tests (5 journeys × desktop & Pixel 7) |
| Production dependency vulnerabilities | **0** (`npm audit --omit=dev`)                                                   |
| Test residue left in the dev database | **0** rows (verified after every phase)                                          |
| Git commits                           | **none yet** — all work is uncommitted                                           |

---

## 2. Phase-by-phase review

Each phase lists: **Goal → Built → Verified → Fixed along the way → Open points → Verdict.**

### Phase 1 — Foundation

- **Goal:** a solid monorepo skeleton the rest could be built on.
- **Built:** npm workspaces (`apps/api`, `apps/web`, `packages/shared`, `packages/contracts`);
  strict TypeScript, ESLint, Prettier; Fastify API with fail-fast config, one standard error
  envelope `{ error: { code, message, requestId } }`, request IDs, PII-redacted logs, security
  headers, CORS, OpenAPI docs; Next.js skeleton; shared money (integer paise) and domain helpers;
  CI workflow.
- **Verified:** format/lint/typecheck/tests/build; the built API and web were run together.
- **Fixed along the way:** Next.js (Turbopack) couldn't resolve `.js` import specifiers in shared
  packages → switched the repo to bundler module resolution; removed a deprecated Fastify option;
  raised test hook timeouts after a cold-start flake.
- **Open points:** none.
- **Verdict:** ✅ Solid. The error envelope, request IDs and shared contracts paid off in every
  later phase.

### Phase 2 — Database

- **Goal:** the TDD schema, corrected by the original review, on Supabase.
- **Built:** Drizzle schema + SQL migrations (17 tables) including the review fixes: pickup points
  and per-batch pickup times, organizer `rejected` status and review fields, catalog requests,
  organizer-level direct links, booking contact/emergency/guest details, policy and commission
  snapshots, idempotency keys, outbox retries, admin audit log. **Business rules enforced in the
  database itself:** seats never exceed capacity, cutoff ≤ departure, direct bookings carry zero
  commission, total = price × quantity, and composite foreign keys so one organizer's batch,
  pickup or link can never be attached to another's. Idempotent seed data.
- **Supabase decisions:** RLS on every table with no policies (the public REST API sees nothing);
  Session pooler (IPv4); DB tests run inside rolled-back transactions so they never change data.
- **Verified:** 16 database tests, each proving a constraint actually fires.
- **Fixed along the way:** one test asserted the wrong constraint (two rules fired; test input
  corrected).
- **Open points:** the dev database password appeared in a screenshot — **rotate it**.
- **Verdict:** ✅ Strong. The database is the last line of defence and it holds even if API code
  has a bug.

### Phase 3 — Authentication & permissions

- **Goal:** verify Supabase logins and enforce roles.
- **Built:** access tokens verified against the project's public signing keys (ES256 JWKS — no
  secret to manage); checks on signature, issuer, audience, expiry, role and anonymous users; user
  rows kept in sync from token claims (without overwriting profile edits); one permission table
  for owner/manager/staff; status rules (pending can prepare drafts, suspended/rejected are
  read-only); guards for signed-in user, admin and organizer-with-permission; `/v1/me`;
  `admin:grant` CLI; temporary login/account pages.
- **Verified:** 18 auth tests; a **real Supabase login** end-to-end; a forged token using your
  project's real key ID was rejected by the live API; you were made admin.
- **Fixed along the way:** no defects; one exported-type compile fix.
- **Open points:** none.
- **Verdict:** ✅ Solid and verified with real credentials.

### Phase 4 — Admin & catalog

- **Goal:** let Ohviana curate treks and review organizers.
- **Built:** catalog trek CRUD with search and paging; organizer approve (with commission) /
  reject / suspend / reinstate / commission change; catalog-request approval (link existing or
  create new, auto-linking waiting drafts) and rejection; audit log. Every admin change is
  audited **in the same transaction**; decisions queue notifications.
- **Verified:** 22 tests including two admins approving simultaneously (exactly one wins) and
  full rollback when an approval fails half-way.
- **Fixed along the way:** **security ordering bug** — validation ran before authorization, so
  non-admins received 400s that revealed request schemas; all guards moved to run first.
  **Data bug** — logins without an email wiped stored emails. Cleaned up rows left by one failed
  test run.
- **Open points:** admins cannot yet view bookings or handle disputes (see section 5).
- **Verdict:** ✅ Good; two real bugs caught by tests before they shipped.

### Phase 5 — Organizer domain

- **Goal:** everything an organizer needs before a customer can book.
- **Built:** registration (pending, caller becomes owner, max 5 per account); profile (slug frozen
  after approval); team management (the last owner can never be removed or demoted, even under
  concurrent changes); trek templates; pickup points; batches — single or bulk weekly creation
  (all-or-nothing), safe edit rules (dates frozen once seats sell, capacity ≥ sold seats),
  publish (approved organizers only), cancel (cancels all bookings atomically), delete drafts;
  PRD dashboard views (draft, upcoming, sold out, booking closed, ongoing, completed, cancelled);
  direct links; dashboard summary.
- **Verified:** 33 tests, including cross-tenant isolation and staff read-only access.
- **Fixed along the way:** the dashboard summary query failed in Postgres (a parameterised
  expression wasn't recognised as the same in SELECT and GROUP BY) — grouped by position instead.
- **Open points:** no explicit tool for seats sold outside Ohviana (organizers can lower capacity).
- **Verdict:** ✅ Complete against the PRD organizer journey.

### Phase 6 — Public discovery API

- **Goal:** the marketplace read side.
- **Built:** trek search (substring + trigram so "kudremuk" finds Kudremukh; district, difficulty,
  optional dates) with per-trek availability (departures, organizers, lowest price, next date);
  departure comparison across organizers sorted by date or price; organizer search and profiles;
  single departure; direct-link landing. **One visibility rule** used everywhere (batch published
  and upcoming, organizer approved, trek and catalog published). Dates are **IST calendar days**.
  Short shared caching; private details never exposed; dead links all look identical.
- **Verified:** 28 tests including the 00:30 IST boundary and instant hiding of suspended
  organizers; sensible live results on seed data.
- **Fixed along the way:** organizer search and direct links returned 500s (an ambiguous column in
  a subquery); a test that leaked data into other tests' expectations was isolated.
- **Open points:** search aggregates all departures per request — fine for the pilot (30 s
  caching), worth revisiting at scale.
- **Verdict:** ✅ Good.

### Phase 7 — Booking engine

- **Goal:** the core: reliable, fair, correctly attributed bookings.
- **Built:** one transaction per booking: idempotency claim → **row lock on the departure** →
  checks (visibility, cutoff, per-booking max, seats, pickup) → **server-side attribution** →
  price and commission snapshot → booking, guests, seat count, audit event, outbox. Guest checkout
  with a one-time access token stored only as a hash. Customer and organizer cancellation
  releasing seats, with a consistent lock order (no deadlocks). Organizer attendee list and
  spreadsheet-safe CSV export. Commission visible to organizers, never to customers.
- **Verified:** 24 tests: **10 simultaneous requests for 3 seats → exactly 3 bookings**;
  **5 identical requests at once → 1 booking**; client-sent price/source ignored; invalid or
  foreign direct-link tokens refused. Concurrency tests stable across repeated runs.
- **Fixed along the way:** an editor-tooling quirk inserted invisible characters (BOM/CRLF) into
  code; rewritten and the whole tree scanned.
- **Open points:** **bookings are free and unverified** (no payment, no OTP) — see risk #1.
  Replaying an idempotent request rotates the guest access token (earlier copies stop working);
  acceptable but worth knowing. Customer cancellation is allowed until departure regardless of
  the policy text (refunds are offline).
- **Verdict:** ✅ Technically the strongest part of the system; the business rules around free
  bookings need a decision.

### Phase 8 — Customer website

- **Goal:** the marketplace UI.
- **Built:** home with search, search results (treks + organizers), trek page with departure
  comparison, organizer pages, departure details, checkout, confirmation/cancel, My bookings,
  direct-link landing, not-found/error pages, sitemap and robots. Plain HTML search forms (work
  before JavaScript); IST everywhere; Indian 10-digit mobiles accepted; one idempotency key per
  checkout attempt; guest token passed in the URL fragment (never reaches servers) then removed.
  SEO: trek/organizer pages indexed with canonical URLs; checkout/booking/direct pages `noindex`.
- **Verified:** production build; every page smoke-tested against live data; 14 unit tests.
- **Fixed along the way:** search errors now show the specific reason; 1-letter queries ignored;
  friendlier API date messages.
- **Open points:** none beyond Phase 10's browser tests (which later caught one bug here).
- **Verdict:** ✅ Complete customer journey.

### Phase 9 — Organizer dashboard & admin console

- **Goal:** the operational UIs.
- **Built:** organizer dashboard (overview with approval banner and review note, batches with PRD
  filter tabs, batch detail with edit / pickups / attendees / CSV / cancel / share link, treks
  with catalog search or request and weekly batch creation, links, team, profile, organizer
  switcher, registration for new users) and admin console (review queue, catalog with change
  history, catalog requests, audit log). Dates entered in IST, prices in rupees.
- **Verified:** typecheck/lint/build; **all 67 API calls made by the web app matched real API
  routes and methods** (checked against the live OpenAPI spec); all console pages served with
  `noindex`.
- **Fixed along the way:** a lint suppression referencing an unloaded rule; form-reset approach
  simplified.
- **Open points:** **no automated browser tests for the consoles** (they need a real Supabase
  login) — the manual walkthrough from Phase 9 is the current check. Admin reason/commission
  input uses browser prompts (functional, basic).
- **Verdict:** ✅ Complete, but the least verified layer (APIs underneath are fully tested).

### Phase 10 — Hardening

- **Goal:** production readiness.
- **Built:** outbox worker (safe with several workers, exponential backoff, dead letters) sending
  email via Resend or logging in dev; maintenance (purge expired keys and old events) and **seat
  reconciliation** alerts; rate limiting (global, bookings, registration, search); Prometheus
  metrics; web security headers; Playwright tests; Dockerfile (API + worker + migrations);
  deployment guide; CI with a browser-test job on a throwaway database.
- **Verified:** 18 new tests; **10/10 browser tests on desktop and Pixel 7**; worker started live;
  bundled migrator verified in the production folder layout; 0 database residue; 0 seat
  mismatches.
- **Fixed along the way:** **rate limits were bypassed** by anonymous floods on protected routes
  (the limit ran after the login check); **"You're booked!" banner never showed** (React's double
  effects consumed the token twice) — found by the browser test; a database array bug in the
  worker's topic filter; the metrics token clashed with login headers.
- **Open points:** Docker image not built (Docker not running locally); CI never run (no GitHub
  remote); see section 5 for configuration cautions.
- **Verdict:** ✅ Good; it found two user-visible bugs that earlier phases had missed.

---

## 3. PRD acceptance criteria

| #   | PRD criterion                                                                | Status | Evidence                                              |
| --- | ---------------------------------------------------------------------------- | ------ | ----------------------------------------------------- |
| 1   | Same batch findable by trek search, organizer search, direct link            | ✅     | public tests; e2e                                     |
| 2   | Search works without dates; date filters return the window                   | ✅     | public tests (incl. IST boundary)                     |
| 3   | Multiple batches per template without sharing seats                          | ✅     | schema test; bulk-create test                         |
| 4   | Only approved organizers and published, cutoff-valid batches accept bookings | ✅     | booking tests                                         |
| 5   | Concurrent attempts for the final seat never oversell                        | ✅     | 10 requests → 3 seats test                            |
| 6   | Direct = 0% commission; marketplace = agreed commission                      | ✅     | DB constraint + booking tests + e2e                   |
| 7   | Payment retries don't double-confirm; expired holds release capacity         | ➖ N/A | payments out of scope; booking retries are idempotent |
| 8   | Organizers can't access other organizers' records                            | ✅     | cross-tenant tests in every module                    |
| 9   | Customers get a verifiable reference and correct status                      | ✅     | booking tests; e2e                                    |

**Pilot metrics (PRD):** bookings by source, rejections (sold out, cutoff) and errors are
measured. **Not yet measured:** organizer activation, search-to-batch click-through and checkout
conversion — there are no product analytics events.

---

## 4. Original PRD/TDD review findings — where they stand

| Original finding                                  | Status                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Pickup options and per-batch pickup times         | ✅ Done                                                                                                |
| Policy snapshot on bookings                       | ✅ Done                                                                                                |
| Commission snapshot and organizer agreement       | ✅ Done (rate on organizer; snapshot per booking)                                                      |
| Organizer reject/suspend; derived batch statuses  | ✅ Done                                                                                                |
| Catalog trek requests                             | ✅ Done                                                                                                |
| Organizer-level branded link                      | ✅ Done                                                                                                |
| Booking contact, emergency contact, guest details | ✅ Done                                                                                                |
| Guest booking lookup                              | ✅ Done (hashed access token)                                                                          |
| Member management                                 | ✅ Done                                                                                                |
| Attendee export                                   | ✅ Done (CSV)                                                                                          |
| Trigram search indexes                            | ✅ Done                                                                                                |
| Analytics events for pilot metrics                | ❌ Not done                                                                                            |
| **Direct-link commission leakage (policy)**       | ⚠️ Partly — tokens unguessable, deactivatable, optional expiry; the business policy is still undecided |
| Off-platform sales / capacity allocation          | ⚠️ Partly — organizers can lower capacity                                                              |
| Admin oversight of bookings and disputes          | ❌ Not done                                                                                            |
| DPDP Act (consent, retention, deletion)           | ❌ Not done                                                                                            |
| WhatsApp notifications                            | ❌ Email only (another notifier can be added)                                                          |
| Payments, GST, refunds                            | ➖ Out of scope by decision                                                                            |

---

## 5. Risks and gaps (ranked)

| #   | Risk / gap                                                                                                                                                                      | Impact                   | Recommendation                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Free, unverified bookings.** No payment and no phone/email verification; rate limit is per IP only. Anyone can reserve seats (up to 10 per booking) and block real customers. | High for a public launch | Before public launch: phone OTP at checkout, a per-phone limit per departure, or organizer confirmation of new bookings. Payments solve it permanently. |
| 2   | **Commission leakage via organizer-wide links** (open since the first review). Organizers can steer marketplace customers to their 0% link.                                     | Revenue                  | Decide policy: e.g. link expiry by default, batch-only links, or "first touch on Ohviana wins".                                                         |
| 3   | **No admin view of bookings or disputes** (PRD persona: admin oversees bookings/disputes).                                                                                      | Ops / trust              | Add read-only admin booking search and a dispute note/flag.                                                                                             |
| 4   | **DPDP Act compliance** — no consent text, retention or deletion process; deleting a user is blocked by their bookings.                                                         | Legal                    | Privacy notice + consent at checkout; retention policy; an anonymise-user procedure.                                                                    |
| 5   | **No product analytics** for the PRD pilot metrics.                                                                                                                             | Can't evaluate the pilot | Add a privacy-friendly analytics tool or simple event logging (search, trek view, checkout start, booking).                                             |
| 6   | **Guest emails can't open the booking on another device** (the access token is deliberately not emailed).                                                                       | Support load             | Optionally email a signed view link, or offer "find my booking" via phone OTP.                                                                          |
| 7   | `TRUST_PROXY=true` trusts the left-most `X-Forwarded-For`, which a client can forge to dodge rate limits.                                                                       | Abuse                    | In production set it to the proxy hop count or proxy IPs, not plain `true`.                                                                             |
| 8   | Web has no Content-Security-Policy; guest tokens live in browser storage.                                                                                                       | XSS impact               | Add a CSP (nonce-based for Next.js) before launch.                                                                                                      |
| 9   | Connection budget: API pool 10 + worker 3 (+ any second API instance) against Supabase's pooler limits on the nano plan.                                                        | Outages under load       | Size pools to the plan; consider the transaction pooler or a compute upgrade.                                                                           |
| 10  | Tests write to the shared **dev** Supabase project (they clean up, but a crash mid-run can leave rows).                                                                         | Dev hygiene              | Use a dedicated test database (`DATABASE_URL_TEST`) or the local Postgres used in CI.                                                                   |
| 11  | Dashboard/admin have no browser tests.                                                                                                                                          | Regressions in UI        | Add a test-only login (e.g. a seeded Supabase test user) and cover the main console flows.                                                              |
| 12  | Not yet done operationally: no git commits, CI never run, Docker image never built, dev DB password exposed.                                                                    | Delivery                 | See section 7.                                                                                                                                          |

---

## 6. Strengths worth keeping

- **Correctness at the lowest layer.** Inventory, commission and tenant rules are enforced by
  database constraints _and_ API checks, each with a test.
- **Concurrency handled deliberately:** row locks, consistent lock order, idempotency keys,
  `SKIP LOCKED` worker claims, and race tests that prove it.
- **One source of truth for contracts.** Zod schemas shared by API, web and docs; the web's API
  calls were verified against the live route list.
- **Security posture:** asymmetric JWT verification, RLS on all tables, guards before validation,
  hashed guest tokens, PII-redacted logs, rate limits, formula-safe CSV, no secrets in the web app.
- **India-first details:** IST everywhere, paise arithmetic, 10-digit mobiles, UTF-8 CSV for
  regional names.
- **Clean test discipline:** every phase ended with zero leftover rows in a shared database.

---

## 7. Recommended next steps

**Before the pilot (days)**

1. Commit the work to git and push to a private GitHub repo so CI runs.
2. Rotate the dev database password; create a separate **production** Supabase project.
3. Build and run the Docker image once; deploy per `docs/DEPLOYMENT.md`.
4. Configure Resend (verified domain) and Supabase custom SMTP.
5. Set `TRUST_PROXY` to the proxy hop count; add a CSP to the web app.
6. Decide the **free-booking abuse** mitigation (risk #1) — at minimum a per-phone limit.

**During the pilot (weeks)** 7. Product analytics for the PRD pilot metrics. 8. Admin booking search and dispute notes. 9. Privacy notice, consent and a data-deletion procedure (DPDP). 10. Direct-link policy decision and enforcement.

**After the pilot** 11. Payments (with GST review), refunds per policy, WhatsApp/SMS notifications. 12. Browser tests for dashboards; dedicated test database; Redis-backed rate limits for multiple
instances.

---

## 8. Conclusion

All ten phases delivered what they set out to do, and each was verified rather than assumed:
231 automated tests, 10 real-browser journeys on desktop and mobile, live checks against Supabase,
and a clean database after every run. The review-and-test loop caught **real defects in nearly
every phase** — a permission-ordering leak, a rate-limit bypass, a lost confirmation banner,
query errors and data-wiping sync — all fixed before they reached a user.

The engineering foundation (schema, booking engine, permissions, contracts) is production-grade
for an MVP. The remaining work is mostly **product and operational**: deciding how to stop free
seat-squatting without payments, settling the direct-link commission policy, giving admins
visibility into bookings, privacy compliance, analytics for the pilot, and the first real
deployment. With the pre-pilot steps in section 7 completed, Ohviana is ready for a controlled
pilot with the planned 3 organizers and 15 departures.

---

## Addendum — 16 Oct 2026: full console walkthrough in a real browser

With the temporary password-less login (`AUTH_MODE=dev`), the organizer and admin consoles could
finally be driven end to end in a browser (`e2e/tests/organizer-console.spec.ts`: register →
admin approval → trek → pickups → weekly batches → publish → share link → guest booking →
attendees CSV → dashboard totals). It found **three real bugs that no earlier test could see**:

| Bug                                              | Effect                                                                                | Fix                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| CORS allowed only GET/HEAD/POST (plugin default) | Browsers blocked **every edit** in the dashboard and admin console (PATCH/PUT/DELETE) | Allowed all methods; regression tests added                     |
| Edit forms were re-mounted after saving          | The "Saved"/"Published" confirmation vanished instantly                               | Removed the re-mount keys (forms already hold the saved values) |
| `Content-Disposition` not exposed to the browser | Attendee CSV always downloaded as `download.csv`                                      | Exposed it (plus `retry-after`, `idempotent-replayed`)          |

This closes the "dashboards have no browser tests" gap from section 5 (item 11) for local runs.
Current totals: **241** unit/integration tests and **11** browser tests, all passing.
