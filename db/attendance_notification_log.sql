-- Dedup log for attendance reminders and reports (idempotent sends).
-- Run in Supabase SQL Editor. Safe to re-run.

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
  for_date      date not null,                 -- punch day for reminders; report period end for reports
  employee_id   uuid references employees (id) on delete cascade, -- reminder target
  recipient_id  uuid references employees (id) on delete cascade, -- report recipient
  period_key    text,                          -- e.g. 2026-07 or 2026-W30
  created_at    timestamptz not null default now()
);

-- Reminders: one per employee per kind per day
create unique index if not exists attn_log_reminder_uniq
  on attendance_notification_log (employee_id, kind, for_date)
  where kind in ('checkin_reminder', 'checkout_reminder');

-- Reports: one per recipient per kind per period
create unique index if not exists attn_log_report_uniq
  on attendance_notification_log (recipient_id, kind, period_key)
  where kind in ('report_daily', 'report_weekly', 'report_monthly');

create index if not exists attn_log_kind_date_idx
  on attendance_notification_log (kind, for_date);
