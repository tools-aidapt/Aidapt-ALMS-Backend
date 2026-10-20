-- Remote work applications.
-- Run this on an existing database. Fresh installs already get the table from schema.sql.
--
-- A check-in outside the office counts as Present only when an Approved request
-- covers that date. Otherwise the punch is kept and the day stays Absent.

create table if not exists remote_work_requests (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references employees (id) on delete cascade,
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
  decision_token text,
  check (to_date >= from_date)
);
create index if not exists remotereq_employee_idx on remote_work_requests (employee_id);
create index if not exists remotereq_manager_idx on remote_work_requests (manager_id);
create index if not exists remotereq_status_idx on remote_work_requests (status);
create index if not exists remotereq_dates_idx
  on remote_work_requests (employee_id, from_date, to_date);
