# Running & testing Ohviana

A hands-on guide for running everything locally on Windows (PowerShell) and testing every
feature from Phases 1–10: first the automated tests, then a manual checklist per phase.

All commands run from the project folder:

```powershell
cd 'D:\$Ohviana_final'
```

---

## 1. One-time setup

You only need this on a fresh machine or clone. On the current PC it's already done.

```powershell
npm install                       # dependencies for all apps and packages
copy .env.example .env            # then fill DATABASE_URL, SUPABASE_URL, NEXT_PUBLIC_SUPABASE_* (see .env.example)
npm run db:migrate                # create/update tables in Supabase
npm run db:seed                   # sample treks, organizers, departures (safe to re-run)
npx -w @ohviana/e2e playwright install chromium   # browser for the e2e tests (~150 MB, once)
```

---

## Sign-in (email + password)

`.env` has `NEXT_PUBLIC_AUTH_MODE=password` and an `AUTH_JWT_SECRET`: people create an account
with email + password on `/login` — no confirmation emails, no Supabase step. Organizers then
register their organization from the Dashboard (the only step that needs admin approval).

Set or reset any account's password (also creates the account if missing):

```powershell
npm run user:set-password -- someone@example.com            # prints a generated password
npm run user:set-password -- someone@example.com 'NewPass123'
```

Other modes: `supabase` (magic-link email) or `dev` (local testing, email only; also set the
API's `AUTH_MODE=dev`). Restart `dev:api` and `dev:web` after changing modes.

## Customer sign-in (mobile + SMS code)

Customers never see `/login`. At checkout, **Confirm booking** texts a 6-digit code to the
contact mobile; entering it signs them in (creating their account the first time) and books.
**My bookings** signs in the same way. Bookings always belong to a signed-in account.

No SMS provider is connected yet (`SMS_PROVIDER=log`): the code appears in the `dev:api` window:

```
Sign-in code for +91******3210: 482913
```

A number can get a new code every 30 s, at most 5 per hour; a code lasts 5 minutes and allows
5 wrong tries. For the browser tests set `OTP_DEV_CODE=123456` in `.env` (every code is then 123456) and restart `dev:api`.

## 2. Start the app

Open **three PowerShell windows** in the project folder:

| Window | Command              | What it is                                                                            | URL                                                                |
| ------ | -------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1      | `npm run dev:api`    | REST API                                                                              | http://localhost:4000/v1/health · docs: http://localhost:4000/docs |
| 2      | `npm run dev:web`    | Website (customer site, dashboard, admin)                                             | http://localhost:3000                                              |
| 3      | `npm run dev:worker` | Optional: sends queued emails (prints them in the log unless `RESEND_API_KEY` is set) | —                                                                  |

They reload automatically when code changes. Stop one with **Ctrl+C**.

**"Port already in use"?** Something is still running on that port. Free it:

```powershell
Get-NetTCPConnection -LocalPort 3000,4000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

---

## 3. Automated tests

| Command         | What it checks                                                                                                                                                                              | Time     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `npm run check` | Formatting, lint, type checks, and **all 231 unit + integration tests** (API, database, shared, web helpers)                                                                                | ~2–3 min |
| `npm run e2e`   | **10 real-browser tests** (desktop + Pixel 7 phone): search → compare → book → confirm → cancel, direct link, validation, SEO. Needs the API and web running (window 1 and 2) and seed data | ~2 min   |
| `npm run build` | Production builds of API, worker and website                                                                                                                                                | ~1 min   |

Useful variations:

```powershell
npm test -w @ohviana/api                                   # only API tests
npx -w @ohviana/api vitest run test/bookings.test.ts       # one test file
npx -w @ohviana/api vitest run -t "last seat"              # tests whose name matches
cd e2e; $env:E2E_SLOWMO=450; npx playwright test --headed --project=desktop   # watch the browser tests run, slowed down
cd e2e; npx playwright show-report                         # HTML report after a run
```

All tests clean up after themselves (database tests use rolled-back transactions; API and
browser tests delete what they create), so your dev data is left untouched.

**What the important tests prove:**

| Test file                             | Proves                                                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db/test/schema.test.ts`     | Database blocks overselling, wrong totals, commission on direct bookings, cross-organizer links                                               |
| `apps/api/test/auth.test.ts`          | Bad/expired/forged login tokens rejected; roles and organizer isolation                                                                       |
| `apps/api/test/admin.test.ts`         | Approve/reject/suspend rules, simultaneous approvals, audit log, rollbacks                                                                    |
| `apps/api/test/organizer.test.ts`     | Registration, team rules, treks, batches, dashboard views, cross-tenant isolation                                                             |
| `apps/api/test/public.test.ts`        | Visibility rule, IST date filtering, search/typos, direct links, caching                                                                      |
| `apps/api/test/bookings.test.ts`      | **10 people race for 3 seats → exactly 3 bookings**; retries never double-book; attribution; cancellation; CSV                                |
| `apps/api/test/worker.test.ts`        | Email delivery, retries/backoff, dead letters, seat reconciliation                                                                            |
| `apps/api/test/hardening.test.ts`     | Rate limits (incl. anonymous floods), metrics endpoint                                                                                        |
| `e2e/tests/booking.spec.ts`           | The real customer journeys in a browser, desktop and mobile                                                                                   |
| `e2e/tests/organizer-console.spec.ts` | The whole organizer + admin flow in a browser (needs `AUTH_MODE=dev`): register → approve → trek → batches → share link → guest booking → CSV |

---

## 4. Manual test checklist (per phase)

With windows 1–3 running. Your account `hello.ohviana@gmail.com` is a platform admin.

### Phase 1 — Foundation

- [ ] http://localhost:4000/v1/health shows `"status":"ok"`.
- [ ] http://localhost:4000/v1/nope shows `{"error":{"code":"NOT_FOUND",…}}`.
- [ ] http://localhost:4000/docs lists all endpoints by section.

### Phase 2 — Database

- [ ] http://localhost:4000/v1/health/ready shows `"database":{"status":"ok"}`.
- [ ] Supabase dashboard → **Table Editor** shows 17 tables with sample data, or run
      `npm run db:studio` for a local database browser.

### Phase 3 — Login & permissions

- [ ] http://localhost:3000/login → email link → **Account** page shows your email and
      **Platform admin: Yes**.
- [ ] On the Account page, **Copy access token**; at http://localhost:4000/docs click
      **Authorize**, paste it, and try `GET /v1/me`. (Tokens last ~1 hour.)

### Phase 4 — Admin & catalog (website: **Admin** in the header)

- [ ] **Catalog → New catalog trek**: create one (e.g. "Brahmagiri"), set _published_, save;
      the change history appears below.
- [ ] Its **Public page** link works: http://localhost:3000/treks/brahmagiri.
- [ ] **Audit log** lists your actions.

### Phase 5 — Organizer side (website: **Dashboard**)

- [ ] First visit shows **registration**: register a test organization → "Awaiting approval".
- [ ] **Admin → Organizers → pending → Approve** with commission `7.5`.
- [ ] **Dashboard → Treks**: create a trek, search the catalog ("Kudremukh"), select, create;
      add itinerary lines, inclusions, cancellation policy → **Save & publish**; add a pickup.
- [ ] Try **Request a new trek** → it appears in **Admin → Catalog requests** → approve it.
- [ ] **Add batches**: first departure, return, price `2499`, _Repeat weekly_ `4` → 4 drafts.
- [ ] **Batches → draft** tab → **Publish** each; the **Upcoming** tab now shows them.
- [ ] **Team**: add someone by email (they must have signed in once); try removing yourself as
      the only owner → refused.

### Trek photos

- [ ] Dashboard → Treks → open a trek → **Photos**: pick a category (Destination, Transport…),
      drag in a few phone photos or click **Choose photos**; set captions, reorder, delete.
- [ ] Open one of its published departures on the site: the gallery shows with category filters;
      click a photo for the full-screen viewer (← → keys, Esc).
- [ ] The trek's card on the home page and its trek page banner use a destination photo.

### Phase 6 — Public discovery

- [ ] http://localhost:3000/search?query=kudremuk (typo) finds Kudremukh.
- [ ] On a trek page, pick dates and **Lowest price first** → list updates; **Show sold out**
      includes full departures.
- [ ] http://localhost:3000/organizers/ghats-trail-co shows that organizer's departures.
- [ ] Your new organizer's departures appear on the trek page; suspend it in Admin → they
      disappear immediately; reinstate → they return.

### Phase 7 — Booking engine

- [ ] Book a departure as a guest (or a private window): pick a pickup, enter a mobile like
      `98765 43210`, confirm → "You're booked!" with an `OHV-XXXXXXXX` reference.
- [ ] Seats left on the trek page drop by the number booked.
- [ ] Reload the confirmation page → still visible on this device; **Cancel booking** → seats
      come back.
- [ ] Sold out: in your dashboard set a batch's capacity to its booked seats → the trek page shows
      **Sold out** and checkout refuses.
- [ ] Dashboard → open the batch → booking listed with **Marketplace** and the commission;
      **Download attendees (CSV)** opens in Excel.

### Phase 8 — Customer website

- [ ] Home, search, trek, organizer, departure, checkout and confirmation pages work on your
      phone too (open `http://<your-PC-IP>:3000` on the same Wi-Fi, or use the browser's device
      toolbar).
- [ ] Wrong phone number at checkout → a clear error, nothing booked.
- [ ] http://localhost:3000/sitemap.xml and http://localhost:3000/robots.txt exist.

### Phase 9 — Dashboards

- [ ] Batch detail: **Create share link** → copy → open in a private window → page says
      "You're booking directly with …" → book → back in the dashboard the booking shows
      **Direct** with no commission.
- [ ] **Direct links** page: copy, then **Deactivate** → the link now shows "no longer valid".
- [ ] **Overview** shows batch counts and booking totals split marketplace vs direct.
- [ ] **Cancel batch** (with a reason) → its bookings are cancelled.
- [ ] Admin → Organizers: **Suspend** with a reason → the organizer's dashboard turns read-only
      and shows the reason; **Reinstate**.

### Phase 10 — Hardening

- [ ] **Emails**: with the worker running (window 3), make or cancel a booking with an email
      address → the worker log prints `email (not sent: log notifier)` lines. With a real
      `RESEND_API_KEY` in `.env` they are actually sent.
- [ ] **Rate limit** — in PowerShell, send 25 bookings quickly (the last few get 429):

  ```powershell
  1..25 | ForEach-Object {
    try { Invoke-RestMethod -Method Post -Uri http://localhost:4000/v1/bookings -Headers @{ 'idempotency-key' = [guid]::NewGuid() } -ContentType 'application/json' -Body '{}' | Out-Null }
    catch { $_.Exception.Response.StatusCode.value__ }
  } | Group-Object | Select-Object Name, Count
  ```

  Expect about 20 × `400` (invalid on purpose, nothing is booked) then `429`.

- [ ] **Metrics** — add `METRICS_TOKEN=local-metrics-token-123456` to `.env`, restart the API, then:

  ```powershell
  (Invoke-WebRequest http://localhost:4000/internal/metrics -Headers @{ 'x-metrics-token' = 'local-metrics-token-123456' }).Content | Select-String 'bookings_|http_requests_total' | Select-Object -First 10
  ```

- [ ] **Security headers**:
      `(Invoke-WebRequest http://localhost:3000).Headers['X-Frame-Options']` → `DENY`.
- [ ] **Browser tests**: `npm run e2e` → `10 passed`.

---

## 5. Troubleshooting

| Symptom                                        | Fix                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| Home page says "API unreachable" / pages error | Start the API (window 1); check http://localhost:4000/v1/health                |
| `health/ready` shows database `error`          | Check `DATABASE_URL` in `.env` (Session pooler URI, URL-encoded password)      |
| Login page: "Set NEXT_PUBLIC_SUPABASE_…"       | Fill both `NEXT_PUBLIC_SUPABASE_*` values in `.env`, restart `dev:web`         |
| Sign-in email never arrives                    | Supabase's free sender allows ~2 emails/hour; wait, or configure custom SMTP   |
| `401` in API docs                              | Copy a fresh access token (they expire after ~1 hour)                          |
| e2e tests fail on "Kudremukh"                  | Seed data missing: `npm run db:seed`                                           |
| `429 RATE_LIMITED` while testing manually      | Wait a minute, or set `RATE_LIMIT_ENABLED=false` in `.env` and restart the API |
| Tests slow or timing out                       | First connection to Supabase can take a few seconds; rerun                     |
