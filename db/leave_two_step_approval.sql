-- Two-step leave approval: manager first, then the final approver (Hitesh).
-- Idempotent: safe to re-run in the Supabase SQL editor.

alter table leave_requests drop constraint if exists leave_requests_status_check;

alter table leave_requests
  add constraint leave_requests_status_check
  check (status in ('Pending', 'Manager Approved', 'Approved', 'Rejected'));

alter table leave_requests
  add column if not exists manager_approved_at timestamptz,
  add column if not exists manager_approved_by uuid references employees (id) on delete set null,
  add column if not exists final_approver_id uuid references employees (id) on delete set null;

create index if not exists leave_final_approver_idx on leave_requests (final_approver_id);
create index if not exists leave_status_idx on leave_requests (status);
