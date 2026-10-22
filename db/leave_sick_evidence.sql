-- Sick leave of 2 or more working days: prescription is uploaded after the
-- employee is back, then accepted by their manager. The file lives in
-- employee_uploads (purpose sick_leave_evidence).
-- Run in the Supabase SQL editor. Safe to re-run.

alter table leave_requests
  add column if not exists evidence_url text;

-- Prescription files are stored here. Create the table when this database
-- never had the photo/CNIC upload migration.
create table if not exists employee_uploads (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references employees (id) on delete cascade,
  purpose      text not null
                 check (purpose in ('photo', 'cnic_front', 'cnic_back', 'sick_leave_evidence')),
  content_type text not null,
  byte_size    integer not null check (byte_size > 0 and byte_size <= 8388608),
  data         bytea not null,
  created_at   timestamptz not null default now()
);

create index if not exists employee_uploads_employee_idx
  on employee_uploads (employee_id);

-- Replace the purpose check so prescription uploads are accepted.
do $$
declare
  r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    where rel.relname = 'employee_uploads'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%cnic_back%'
      and pg_get_constraintdef(con.oid) not ilike '%sick_leave_evidence%'
  loop
    execute format('alter table employee_uploads drop constraint %I', r.conname);
  end loop;
end $$;

alter table employee_uploads drop constraint if exists employee_uploads_purpose_check;

alter table employee_uploads
  add constraint employee_uploads_purpose_check
  check (purpose in ('photo', 'cnic_front', 'cnic_back', 'sick_leave_evidence'));

alter table leave_requests drop constraint if exists leave_requests_status_check;

alter table leave_requests
  add constraint leave_requests_status_check
  check (status in (
    'Pending',
    'Manager Approved',
    'Approved',
    'Rejected',
    'Awaiting Prescription',
    'Prescription Submitted',
    'Prescription Missing'
  ));
