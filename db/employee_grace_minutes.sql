-- Per-employee grace override (nullable = inherit shift grace).
-- Run in Supabase SQL Editor. Safe to re-run.

alter table employees
  add column if not exists grace_minutes integer
    check (grace_minutes is null or grace_minutes >= 0);
