-- Finance entries mirrored from the ClickUp list ORG - Finance.
-- Run in the Supabase SQL editor. Safe to re-run.

create table if not exists finance_entries (
  id                   uuid primary key default gen_random_uuid(),
  clickup_task_id      text not null unique,
  name                 text not null,
  status               text,
  total_amount         numeric,
  purchase_date        date,
  purchase_month_key   text not null default '',
  purchase_month_label text not null default '',
  purchase_type        text,
  comment              text,
  attachments          jsonb not null default '[]'::jsonb,
  clickup_url          text,
  task_created_at      timestamptz,
  synced_at            timestamptz not null default now(),
  created_at           timestamptz not null default now()
);

create index if not exists finance_entries_month_idx
  on finance_entries (purchase_month_key);
