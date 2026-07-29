-- Add decided_by to leave_requests so we record who approved/rejected.
-- Idempotent: safe to re-run in Supabase SQL Editor.

alter table leave_requests
  add column if not exists decided_by uuid references employees (id) on delete set null;

create index if not exists leave_decided_by_idx on leave_requests (decided_by);
