# Test and production environments

Two complete copies of Ohviana, each with its own website, API, worker, database and sign-in:

|                         | Test                                            | Production                                    |
| ----------------------- | ----------------------------------------------- | --------------------------------------------- |
| Website                 | `https://test.ohviana.com`                      | `https://ohviana.com`                         |
| API                     | `https://api.test.ohviana.com`                  | `https://api.ohviana.com`                     |
| Vercel projects         | `ohviana-web-test`, `ohviana-apis-test`         | `ohviana-web`, `ohviana-apis`                 |
| Deploys from branch     | `main`, on every merge                          | `production`, only via **Release**            |
| Supabase (DB + sign-in) | the original project (`ngmjraywukilwgjujjyr`)   | a new project (Mumbai)                        |
| Data                    | sample organizers and test bookings; resettable | real only; starts empty                       |
| Search engines          | kept out (`NEXT_PUBLIC_ENVIRONMENT=test`)       | indexed; sitemap in Search Console            |
| Booking emails (Resend) | optional: leave `RESEND_API_KEY` unset to log   | on                                            |
| Sign-in codes (Brevo)   | Brevo SMTP in the test Supabase project         | Brevo SMTP in the production Supabase project |

## Day to day

One branch, `main`, plus a release button:

1. Work on a branch; open a pull request into **`main`**. CI runs; merge it.
2. Vercel deploys the **test** projects (migrations run against the test database first).
3. Check the change on `test.ohviana.com`.
4. GitHub → Actions → **Release to production** → **Run workflow** (leave "commit" empty for the
   latest `main`). It refuses commits that aren't on `main` or didn't pass CI, then moves the
   `production` branch there; Vercel deploys production (migrations against the production
   database first).

Do both repositories in the same order every time: **ohviana-apis first**, check
`https://api.ohviana.com/v1/health/ready`, then ohviana-web.

Everything merged to `main` goes out with the next release, so merge only finished work.
**Rollback**: run Release with an older commit from `main` (or use Vercel's Instant Rollback).
Nobody commits to `production` by hand; only the workflow moves it.

Optional approval step: GitHub → Settings → Environments → **production** → Required reviewers.
The release then waits for an approver.

## One-time setup

The current site becomes **test**; production is built new next to it, then the domains move.
Expect a few minutes when `ohviana.com` points nowhere useful while the domains move (step 6).

### 0. Branches

- [ ] In both repositories, create **`production`** from `main` on GitHub (branch menu → type
      `production` → Create). The Release workflow moves it from then on.

### 1. New production Supabase project

- [ ] Supabase → **New project**, region **Mumbai (ap-south-1)**, a strong database password
      (letters and digits avoid URL-encoding problems).
- [ ] **Connect**: copy the **transaction pooler** URI (port 6543, for `DATABASE_URL`) and the
      **session pooler** URI (port 5432, for `MIGRATE_DATABASE_URL`).
- [ ] **Authentication → URL Configuration**: Site URL `https://ohviana.com`; Redirect URLs
      `https://ohviana.com/auth/callback`.
- [ ] **Authentication → Emails → SMTP Settings**: custom SMTP via Brevo (host
      `smtp-relay.brevo.com`, port 587, Brevo login, an SMTP key) and a sender verified in
      Brevo, ideally `no-reply@ohviana.com` on the authenticated `ohviana.com` domain.
- [ ] **Authentication → Emails → Templates**: the sign-in code email in both **Confirm sign up**
      and **Magic link** (it must contain `{{ .Token }}`; see RUNBOOK).
- [ ] **Authentication → Providers → Email**: enabled, **Confirm email** on, **Email OTP Length** 6. **Rate Limits**: raise emails per hour.
- [ ] **Google Cloud → Credentials** → your OAuth client: add the authorized redirect URI
      `https://<new-project-ref>.supabase.co/auth/v1/callback` (keep the test project's one too).
- [ ] **Authentication → Providers → Google**: enable with the same client ID and secret.

### 2. Rename the current Vercel projects to test

- [ ] `ohviana-web` → Settings → General → rename to **`ohviana-web-test`**.
- [ ] `ohviana-apis` → rename to **`ohviana-apis-test`**.

### 3. New production Vercel projects

- [ ] **Add New → Project** → import `ohviana/ohviana-apis` as **`ohviana-apis`**, then Settings →
      Environments → Production → Branch Tracking: **`production`**. Production environment variables, all new values except the Brevo/Resend
      keys:

  | Variable                                       | Value                                   |
  | ---------------------------------------------- | --------------------------------------- |
  | `NODE_ENV`                                     | `production`                            |
  | `PORT`                                         | `4000`                                  |
  | `AUTH_MODE`                                    | `supabase`                              |
  | `SUPABASE_URL`                                 | `https://<new-project-ref>.supabase.co` |
  | `DATABASE_URL`                                 | new transaction pooler URI (6543)       |
  | `MIGRATE_DATABASE_URL`                         | new session pooler URI (5432)           |
  | `DB_POOL_MAX`                                  | `3`                                     |
  | `AUTH_JWT_SECRET`                              | a new 32+ character random string       |
  | `METRICS_TOKEN`                                | a new 32+ character random string       |
  | `CORS_ORIGINS`                                 | `https://ohviana.com`                   |
  | `PUBLIC_SITE_URL`                              | `https://ohviana.com`                   |
  | `TRUST_PROXY`                                  | `true`                                  |
  | `RATE_LIMIT_ENABLED` / `RATE_LIMIT_GLOBAL_MAX` | `true` / `300`                          |
  | `LOG_LEVEL`                                    | `info`                                  |
  | `RESEND_API_KEY`, `EMAIL_FROM`                 | booking emails                          |
  | `ADMIN_NOTIFY_EMAIL`                           | where "new organizer" notices go        |

  Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
  Never set `OTP_DEV_CODE` or `AUTH_MODE=dev` here (the API refuses to start with them).

- [ ] Deploy. The build creates every table in the new database (migrations), then starts the
      API and worker. Check `https://<new-api>.vercel.app/v1/health/ready`.
- [ ] Import `ohviana/ohviana-web` as **`ohviana-web`** (Branch Tracking **`production`**):

  | Variable                               | Value                                   |
  | -------------------------------------- | --------------------------------------- |
  | `NEXT_PUBLIC_API_BASE_URL`             | `https://api.ohviana.com`               |
  | `NEXT_PUBLIC_SITE_URL`                 | `https://ohviana.com`                   |
  | `NEXT_PUBLIC_AUTH_MODE`                | `supabase`                              |
  | `NEXT_PUBLIC_SUPABASE_URL`             | `https://<new-project-ref>.supabase.co` |
  | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | the new project's publishable key       |

  Leave `NEXT_PUBLIC_ENVIRONMENT` unset. Deploy.

### 4. Get the new code onto main

- [ ] Push the open branches and merge them into `main` through pull requests, ohviana-apis
      first. The test projects (still on `ohviana.com` until step 6) update automatically.

### 5. Release to production

- [ ] Run **Release to production** in ohviana-apis, check the new API's
      `….vercel.app/v1/health/ready`, then run it in ohviana-web.

### 6. Move the domains

- [ ] `ohviana-web-test` → Settings → Domains: remove `ohviana.com` (and `www`); add
      `test.ohviana.com`.
- [ ] `ohviana-apis-test`: remove `api.ohviana.com`; add `api.test.ohviana.com`.
- [ ] `ohviana-web`: add `ohviana.com` (and `www.ohviana.com` redirecting to it).
- [ ] `ohviana-apis`: add `api.ohviana.com`.
- [ ] DNS: create the records Vercel shows for `test.ohviana.com` and `api.test.ohviana.com`
      (the existing `ohviana.com` and `api.ohviana.com` records keep working).

### 7. Point the test projects at test addresses

- [ ] `ohviana-web-test` (keeps deploying `main`) → Production variables:
      `NEXT_PUBLIC_SITE_URL=https://test.ohviana.com`,
      `NEXT_PUBLIC_API_BASE_URL=https://api.test.ohviana.com`, **`NEXT_PUBLIC_ENVIRONMENT=test`**
      (Supabase variables unchanged).
- [ ] `ohviana-apis-test`: `CORS_ORIGINS=https://test.ohviana.com`,
      `PUBLIC_SITE_URL=https://test.ohviana.com` (database and Supabase unchanged).
- [ ] The original Supabase project → URL Configuration: Site URL `https://test.ohviana.com`;
      Redirect URLs `https://test.ohviana.com/auth/callback`,
      `http://localhost:3000/auth/callback`.
- [ ] Redeploy both test projects (public web variables are built in).
- [ ] Rotate the original database's password: it was shared during development. Update
      `DATABASE_URL` / `MIGRATE_DATABASE_URL` in the test project and your local `.env`.

### 8. First production data

- [ ] Do **not** run `db:seed` against production (it refuses with `NODE_ENV=production`).
- [ ] Sign in once on `https://ohviana.com`, then grant yourself admin:
      `DATABASE_URL='<production session pooler URI>' npm run admin:grant -- you@example.com`.
- [ ] Add the catalog treks in **Admin → Catalog**; approve organizers as they register.
- [ ] Google Search Console: submit `https://ohviana.com/sitemap.xml`.

### 9. Check both

- [ ] `test.ohviana.com` shows the yellow "Test environment" banner; `/robots.txt` says
      `Disallow: /`.
- [ ] `ohviana.com` has no banner; `/robots.txt` lists the sitemap.
- [ ] Sign in with Google and with an email code on both.

Local development keeps using the **test** database (`.env`). Production credentials stay in
Vercel; use them locally only for one-off commands such as `admin:grant`.
