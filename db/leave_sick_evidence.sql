-- Sick leave of 2 or more working days must attach a doctor's prescription.
-- The file itself lives in employee_uploads (purpose sick_leave_evidence).
-- Run in the Supabase SQL editor. Safe to re-run.

alter table leave_requests
  add column if not exists evidence_url text;

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
