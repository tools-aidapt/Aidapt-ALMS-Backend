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
  date_of_joining    date,
  monthly_salary     numeric,
  status             text not null default 'Active'
                       check (status in ('Active','Inactive')),
  bank_name          text,
  bank_account_no    text,
  address            text,
  phone_no           text,
  emergency_phone_no text,
  photo_url          text,
  employment_status  text not null default 'Full-time'
                       check (employment_status in ('Probation','Full-time')),
  created_at         timestamptz not null default now()
);
create index if not exists employees_manager_idx on employees (manager_id);

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
  decision_token text
);
create index if not exists leave_employee_idx on leave_requests (employee_id);
create index if not exists leave_token_idx on leave_requests (decision_token);

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
