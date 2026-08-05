-- ALMS schema for Supabase / Postgres.
-- Run this in the Supabase SQL editor (or via psql) before starting the API.
-- Business logic stays in the Node service layer; this schema only enforces
-- shape, keys, and the few invariants a relational store can guarantee.

create extension if not exists pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Shifts
-- ---------------------------------------------------------------------------
create table if not exists shifts (
  id            uuid primary key default gen_random_uuid(),
  shift_name    text not null,
  start_time    text not null,               -- "09:00"
  end_time      text not null,               -- "18:00"
  grace_minutes integer not null default 0,
  working_days  text[] not null default '{}' -- {Mon,Tue,...}
);

-- ---------------------------------------------------------------------------
-- Employees  (id == Supabase auth.users.id, 1:1)
-- ---------------------------------------------------------------------------
create table if not exists employees (
  id                 uuid primary key references auth.users (id) on delete cascade,
  name               text not null,
  email              text not null unique,
  role               text not null default 'Employee'
                       check (role in ('Employee','Manager','HR Admin')),
  manager_id         uuid references employees (id) on delete set null,
  assigned_shift_id  uuid references shifts (id) on delete set null,
  team_id            uuid, -- FK added after teams table exists
  date_of_joining    date,
  monthly_salary     numeric,
  status             text not null default 'Active'
                       check (status in ('Active','Inactive')),
  bank_name          text,
  bank_account_no    text,
  bank_account_holder_name text,
  iban               text,
  address            text,
  current_address    text,
  permanent_address  text,
  phone_no           text,
  emergency_phone_no text,
  emergency_contacts jsonb not null default '[]'::jsonb,
  education          jsonb not null default '[]'::jsonb,
  experience         jsonb not null default '[]'::jsonb,
  date_of_birth      date,
  medical_notes      text not null default '',
  cnic_front_url     text,
  cnic_back_url      text,
  photo_url          text,
  employment_status  text not null default 'Full-time'
                       check (employment_status in ('Probation','Full-time')),
  grace_minutes      integer
                       check (grace_minutes is null or grace_minutes >= 0),
  created_at         timestamptz not null default now()
);
create index if not exists employees_manager_idx on employees (manager_id);

-- ---------------------------------------------------------------------------
-- Teams (lead is an employee; members point back via employees.team_id)
-- ---------------------------------------------------------------------------
create table if not exists teams (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  lead_id    uuid references employees (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists teams_lead_idx on teams (lead_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'employees_team_id_fkey'
  ) then
    alter table employees
      add constraint employees_team_id_fkey
      foreign key (team_id) references teams (id) on delete set null;
  end if;
end $$;
create index if not exists employees_team_idx on employees (team_id);

-- ---------------------------------------------------------------------------
-- Office config (single row expected)
-- ---------------------------------------------------------------------------
create table if not exists office_config (
  id            uuid primary key default gen_random_uuid(),
  label         text,
  latitude      double precision,
  longitude     double precision,
  radius_meters integer
);

-- ---------------------------------------------------------------------------
-- Attendance punches  (one per employee per day)
-- ---------------------------------------------------------------------------
create table if not exists attendance_punches (
  id                uuid primary key default gen_random_uuid(),
  employee_id       uuid not null references employees (id) on delete cascade,
  date              date not null,
  check_in_time     timestamptz,
  check_out_time    timestamptz,
  check_in_lat      double precision,
  check_in_lng      double precision,
  check_in_accuracy double precision,
  distance_meters   double precision,
  mode              text check (mode in ('Office','Remote In')),
  is_late           boolean not null default false,
  late_by_minutes   integer,
  worked_hours      numeric,
  worked_minutes    integer,
  overtime_hours    numeric,
  status            text check (status in ('Present','On Leave','Holiday','Absent')),
  unique (employee_id, date)
);
create index if not exists punches_date_idx on attendance_punches (date);

-- ---------------------------------------------------------------------------
-- Leave requests
-- ---------------------------------------------------------------------------
create table if not exists leave_requests (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references employees (id) on delete cascade,
  leave_type     text not null check (leave_type in ('Annual','Sick','Casual')),
  from_date      date not null,
  to_date        date not null,
  days           integer not null,
  reason         text,
  status         text not null default 'Pending'
                   check (status in ('Pending','Approved','Rejected')),
  manager_id     uuid references employees (id) on delete set null,
  applied_at     timestamptz not null default now(),
  decided_at     timestamptz,
  decided_by     uuid references employees (id) on delete set null,
  decision_token text
);
create index if not exists leave_employee_idx on leave_requests (employee_id);
create index if not exists leave_token_idx on leave_requests (decision_token);
create index if not exists leave_decided_by_idx on leave_requests (decided_by);

-- ---------------------------------------------------------------------------
-- Leave balances  (one row per employee)
-- ---------------------------------------------------------------------------
create table if not exists leave_balances (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null unique references employees (id) on delete cascade,
  annual       numeric not null default 0,
  sick         numeric not null default 0,
  casual       numeric not null default 0,
  last_updated timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Holidays
-- ---------------------------------------------------------------------------
create table if not exists holidays (
  id         uuid primary key default gen_random_uuid(),
  date       date not null unique,
  name       text,
  added_by   uuid references employees (id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Regularization log (audit trail for corrected punches)
-- ---------------------------------------------------------------------------
create table if not exists regularization_log (
  id            uuid primary key default gen_random_uuid(),
  punch_id      uuid references attendance_punches (id) on delete set null,
  edited_by     uuid references employees (id) on delete set null,
  field_changed text,
  old_value     text,
  new_value     text,
  created_at    timestamptz not null default now()
);
create index if not exists reglog_punch_idx on regularization_log (punch_id);

-- ---------------------------------------------------------------------------
-- Password reset OTPs (single-use, hashed at rest, attempt-limited)
-- ---------------------------------------------------------------------------
create table if not exists password_reset_tokens (
  id                      uuid primary key default gen_random_uuid(),
  employee_id             uuid not null references employees (id) on delete cascade,
  token_hash              text not null,        -- sha256 of the 6-digit OTP sent by email
  expires_at              timestamptz not null, -- OTP expiry
  used_at                 timestamptz,          -- set when the password is finally reset
  attempts                integer not null default 0,
  verified_at             timestamptz,          -- set when the OTP is verified
  reset_token_hash        text,                 -- sha256 of the reset token issued after OTP verify
  reset_token_expires_at  timestamptz,          -- reset-token expiry
  created_at              timestamptz not null default now()
);
create index if not exists prt_employee_idx on password_reset_tokens (employee_id);

-- ---------------------------------------------------------------------------
-- Regularization requests (employee-submitted punch corrections, manager-approved)
-- ---------------------------------------------------------------------------
create table if not exists regularization_requests (
  id                       uuid primary key default gen_random_uuid(),
  employee_id              uuid not null references employees (id) on delete cascade,
  date                     date not null,
  requested_check_in_time  timestamptz,
  requested_check_out_time timestamptz,
  reason                   text,
  status                   text not null default 'Pending'
                             check (status in ('Pending','Approved','Rejected')),
  manager_id               uuid references employees (id) on delete set null,
  punch_id                 uuid references attendance_punches (id) on delete set null,
  applied_at               timestamptz not null default now(),
  decided_at               timestamptz
);
create index if not exists regreq_employee_idx on regularization_requests (employee_id);
create index if not exists regreq_manager_idx on regularization_requests (manager_id);
create index if not exists regreq_status_idx on regularization_requests (status);

-- ---------------------------------------------------------------------------
-- Employee monthly late strikes
-- One row per employee per calendar month. late_count is the number of late
-- punch days; every 3rd late (3, 6, 9...) is recorded in strike_items
-- with the strike date and reason. Recomputed from attendance_punches.is_late.
-- ---------------------------------------------------------------------------
create table if not exists employee_monthly_strikes (
  id                    uuid primary key default gen_random_uuid(),
  employee_id           uuid not null references employees (id) on delete cascade,
  year_month            text not null
                          check (year_month ~ '^\d{4}-\d{2}$'),
  late_count            integer not null default 0
                          check (late_count >= 0),
  strike_count          integer not null default 0
                          check (strike_count >= 0),
  strike_items          jsonb not null default '[]'::jsonb,
  updated_at            timestamptz not null default now(),
  unique (employee_id, year_month)
);
create index if not exists monthly_strikes_employee_idx on employee_monthly_strikes (employee_id);
create index if not exists monthly_strikes_month_idx on employee_monthly_strikes (year_month);

-- Keep leave_balances.last_updated fresh on every update.
create or replace function touch_last_updated() returns trigger as $$
begin
  new.last_updated = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_leave_balances_touch on leave_balances;
create trigger trg_leave_balances_touch
  before update on leave_balances
  for each row execute function touch_last_updated();

create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_monthly_strikes_touch on employee_monthly_strikes;
create trigger trg_monthly_strikes_touch
  before update on employee_monthly_strikes
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Attendance notification log (reminder / report send dedup)
-- ---------------------------------------------------------------------------
create table if not exists attendance_notification_log (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null
                  check (kind in (
                    'checkin_reminder',
                    'checkout_reminder',
                    'report_daily',
                    'report_weekly',
                    'report_monthly'
                  )),
  for_date      date not null,
  employee_id   uuid references employees (id) on delete cascade,
  recipient_id  uuid references employees (id) on delete cascade,
  period_key    text,
  created_at    timestamptz not null default now()
);
create unique index if not exists attn_log_reminder_uniq
  on attendance_notification_log (employee_id, kind, for_date)
  where kind in ('checkin_reminder', 'checkout_reminder');
create unique index if not exists attn_log_report_uniq
  on attendance_notification_log (recipient_id, kind, period_key)
  where kind in ('report_daily', 'report_weekly', 'report_monthly');
create index if not exists attn_log_kind_date_idx
  on attendance_notification_log (kind, for_date);

-- ---------------------------------------------------------------------------
-- Employee uploads (photos + CNIC scans; binary stored privately)
-- ---------------------------------------------------------------------------
create table if not exists employee_uploads (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references employees (id) on delete cascade,
  purpose      text not null
                 check (purpose in ('photo', 'cnic_front', 'cnic_back')),
  content_type text not null,
  byte_size    integer not null check (byte_size > 0 and byte_size <= 8388608),
  data         bytea not null,
  created_at   timestamptz not null default now()
);
create index if not exists employee_uploads_employee_idx
  on employee_uploads (employee_id);
