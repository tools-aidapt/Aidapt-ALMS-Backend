# ALMS Backend

Attendance & Leave Management System — a Node.js/Express REST API backed by
**Supabase** (Postgres for data, Supabase Auth for identity). **All business
logic lives in the Node service layer.**

## Stack

- Node.js (LTS) + Express
- **Postgres** via `pg` (Supabase database) — parameterised SQL + transactions
- **Supabase Auth** for credentials/sessions; access tokens verified with the
  project JWT secret (`jsonwebtoken`)
- `zod` request validation
- Email dispatched to an **n8n webhook** (n8n performs the actual send)
- `node-cron` for the optional daily absent-marking job
- **Structured request/response logging** (payloads redacted) + per-IP rate
  limiting (`express-rate-limit`, 60 req/min; health check exempt)

## Setup

```bash
npm install
cp .env.example .env      # then fill in the values
# 1) Apply the schema to your Supabase DB:
#    open db/schema.sql in the Supabase SQL editor and run it (or psql < db/schema.sql)
npm run dev               # nodemon, or: npm start
```

## Deploy (AWS App Runner)

The app listens on `PORT` (default 4000) and binds `0.0.0.0`, so no code change is
needed. `apprunner.yaml` defines the build (`npm ci`), start (`node src/server.js`),
and port (4000).

1. **App Runner → Create service → Source: GitHub** → connect this repo, branch
   `main`. Use the configuration file (`apprunner.yaml`).
2. **Environment variables** (Configuration → Environment variables) — set all of:
   `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `N8N_EMAIL_WEBHOOK_URL`, `N8N_PASSWORD_RESET_WEBHOOK_URL`, `EMAIL_FROM`,
   `OFFICE_GEOFENCE_DEFAULT_RADIUS_M`, `APP_BASE_URL`.
   Put `DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in **AWS Secrets Manager**
   and reference them; the rest can be plaintext. (`NODE_ENV`, `PORT`,
   `TRUST_PROXY` come from `apprunner.yaml`.)
3. **Health check:** HTTP, path `/health` (a dedicated top-level route, outside
   `/api` — unlogged and never rate-limited, so frequent probes stay cheap).
4. After the first deploy, set `APP_BASE_URL` to the App Runner service URL and
   redeploy so email links resolve correctly.

Supabase is reached over the public internet (the pooler URL), so no VPC
connector is required.

### Scheduled jobs on App Runner

App Runner throttles CPU between requests, so the in-process `node-cron` timer is
unreliable (and would double-fire if scaled to >1 instance). `apprunner.yaml`
therefore sets **`ENABLE_CRON=false`**. Trigger the daily absent-marker
externally instead:

- Endpoint: `POST /api/jobs/mark-absent` — authenticated by the **`X-Job-Secret`**
  header matching the `JOBS_SECRET` env var (not user JWT). Optional body
  `{ "date": "YYYY-MM-DD" }`, defaults to today (PKT). Idempotent.
- Schedule an **n8n** (or Supabase `pg_cron`) job to call it at **23:30
  Asia/Karachi** with the `X-Job-Secret` header.

  ```
  POST https://<service>/api/jobs/mark-absent
  X-Job-Secret: <JOBS_SECRET>
  ```

Set `JOBS_SECRET` in the App Runner env (Secrets Manager) alongside the others.

Required env vars are validated at startup (`src/config/env.js`) — the process
refuses to boot if `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, or `SUPABASE_JWT_SECRET` are missing.

### Supabase project

1. Create a Supabase project.
2. Run `db/schema.sql` (SQL editor). It creates the 8 tables with real foreign
   keys/constraints; `employees.id` references `auth.users(id)` 1:1.
3. Copy the values into `.env`: `DATABASE_URL` (Settings → Database → Connection
   string), and `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`
   / `SUPABASE_JWT_SECRET` (Settings → API).

> **First HR Admin:** register via `POST /api/auth/register` (creates an
> `Employee`), then promote them to `HR Admin` — either `UPDATE employees SET
> role='HR Admin' WHERE email='...';` in SQL, or via another HR Admin's
> `PATCH /employees/:id`.

### Migrating existing Airtable data (one-off)

```bash
# .env must also have AIRTABLE_API_KEY + AIRTABLE_BASE_ID
node scripts/migrate-from-airtable.js
```

Copies all tables, remapping Airtable record ids to UUIDs. **Auth caveat:**
bcrypt password hashes can't be reused, so each migrated user is created with a
random temp password and **must reset their password**. The script prints the
affected emails.

## Architecture

```
controllers → services → models → config/db (pg)      [data]
authService / auth middleware → config/supabase        [identity]
```

- **controllers** — HTTP only: validation, auth/ownership checks, response shaping.
- **services** — all business logic (geofence, lateness, hours, leave day-count,
  balance deduction, approval flow). Framework-independent and unit-testable.
- **models** — thin per-table wrappers over `pg`. Each returns the record shape
  `{ id, fields, createdTime }`; foreign keys are surfaced as `[id]` arrays so
  the service/controller layer was unaffected by the Airtable → Postgres swap.
- **transactions** — `config/db.withTransaction()` wraps multi-step invariants;
  leave approval (balance check → deduct → status flip) runs atomically with a
  `SELECT … FOR UPDATE` row lock.

### Response conventions

- Success: `{ "data": ... }`
- Error: `{ "error": { "code": "STRING_CODE", "message": "..." } }`
- Status codes: 400 validation · 401 unauthenticated · 403 unauthorized ·
  404 not found · 409 conflict · 5xx unexpected/upstream.

## Core logic notes

- **Timezone:** business time is PKT (Asia/Karachi, UTC+5, no DST). Times are
  stored as UTC ISO strings; lateness/"today"/day-counts are computed in PKT via
  a fixed +5h offset (`src/utils/dateUtils.js`).
- **Geofence:** Haversine distance from `OfficeConfig` centre. `Mode = Office` if
  `distance ≤ radius`, else `Remote In`.
- **Overtime:** `max(0, workedHours − shiftLength)`, computed at checkout.
- **Leave days:** calendar days inclusive, minus non-working weekdays (per the
  employee's shift `WorkingDays`) and any date in Holidays.
- **Leave balance:** deducted on approval; approval fails with 409 if the balance
  is insufficient (deduction runs *before* the status flips to Approved).
- **Email approval:** a single-use `DecisionToken` is generated at submit time;
  the email link hits `GET /api/leave/requests/:id/decide?token=...&action=...`,
  which validates the token (constant-time) and clears it after use.
- **Email delivery:** the backend never sends mail directly. `emailService`
  POSTs a JSON payload (`event`, rendered `to`/`subject`/`html`, plus structured
  `data`) to `N8N_EMAIL_WEBHOOK_URL`; the n8n workflow sends the actual email. If
  the URL is unset, payloads are logged (so approval links stay visible in dev).

## API

All routes are under `/api`. Auth via `Authorization: Bearer <JWT>` unless noted.
Health check: `GET /api/health`.

See the development brief (§7) for the full endpoint table. Highlights:

| Method | Path | Auth |
|---|---|---|
| POST | `/auth/login` | Public |
| POST | `/auth/forgot-password` | Public (sends OTP) |
| POST | `/auth/verify-otp` | Public (returns reset token) |
| POST | `/auth/reset-password` | Public (reset-token-gated) |
| GET | `/auth/me` | Any |
| GET | `/dashboard` | Any (current user) |
| POST | `/attendance/checkin` | Any authenticated (self) |
| POST | `/attendance/checkout` | Any authenticated (self) |
| GET | `/attendance/overview` | self (`?employeeId=` for Manager/HR) |
| POST | `/leave/requests` | Employee+ |
| PATCH | `/leave/requests/:id/approve` | Manager, HR Admin |
| GET | `/leave/requests/:id/decide` | Public (token-gated) |
| PATCH | `/admin/punches/:id` | HR Admin |
| GET | `/admin/regularization-log` | HR Admin |

## Notable implementation decisions (deviations / clarifications)

- **Check-in/out is open to any authenticated user for their own record**, not
  literally the `Employee` role only — managers and HR admins also attend. Scope
  is always "self".
- **Auth is Supabase Auth.** `register` / `create employee` create a Supabase
  auth user, then an `employees` row with the same id. Login returns Supabase's
  access token; the auth middleware verifies it with `SUPABASE_JWT_SECRET` and
  loads the app role from the `employees` table (authoritative).
- **Foreign keys are surfaced as `[id]` arrays** in the model layer (e.g.
  `Manager: ["<uuid>"]`) to preserve the response shapes the frontend already
  consumes from the Airtable era.
- **Leave approval is transactional** — balance check, deduction, and status
  flip run in one DB transaction with a row lock.
- **Password reset is a 3-step OTP flow, backend-owned** (not Supabase's
  built-in email):
  1. `forgot-password { email }` — generates a 6-digit OTP, stores only its
     *hash*, emails it via a dedicated n8n webhook
     (`N8N_PASSWORD_RESET_WEBHOOK_URL`). OTP: 10-min expiry, single-use,
     attempt-limited (5). Always returns 200 (no enumeration).
  2. `verify-otp { email, otp }` — verifies the code and returns a single-use
     **reset token** (15-min expiry). Changes no password.
  3. `reset-password { email, resetToken, password }` — sets the new password via
     the Supabase admin API and consumes the token.
- **Absent-marking cron** runs 23:30 Asia/Karachi; disable with `ENABLE_CRON=false`.
  `markAbsentees()` is idempotent and exported for manual/testing use.
- **`register` / `create employee`** also seed a zeroed `leave_balances` row.

## Tests

Pure-logic unit tests (geo, dates, lateness, leave-day counting) run with the
built-in Node test runner:

```bash
npm test
```
