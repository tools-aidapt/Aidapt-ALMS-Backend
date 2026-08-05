-- Private employee file uploads (photos + CNIC scans).
-- Binary content lives in-database so CNIC bytes are never on a public CDN URL.
-- Run in Supabase SQL Editor. Safe to re-run.

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
