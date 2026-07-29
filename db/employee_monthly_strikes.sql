-- Run this in the Supabase SQL editor if the DB was created from an older schema.sql.
-- Idempotent: safe to re-run.
--
-- IMPORTANT: This file only creates/updates the table schema (DDL).
-- To fill historical strike rows, run db/employee_monthly_strikes_backfill.sql
-- in a separate query (do not combine DDL + backfill in one run — that can deadlock).

create table if not exists employee_monthly_strikes (
  id                    uuid primary key default gen_random_uuid(),
  employee_id           uuid not null references employees (id) on delete cascade,
  year_month            text not null
                          check (year_month ~ '^\d{4}-\d{2}$'),
  late_count            integer not null default 0
                          check (late_count >= 0),
  strike_count          integer not null default 0
                          check (strike_count >= 0),
  strike_items          jsonb not null default '[]'::jsonb,
  updated_at            timestamptz not null default now(),
  unique (employee_id, year_month)
);
create index if not exists monthly_strikes_employee_idx on employee_monthly_strikes (employee_id);
create index if not exists monthly_strikes_month_idx on employee_monthly_strikes (year_month);

alter table employee_monthly_strikes
  add column if not exists strike_items jsonb not null default '[]'::jsonb;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_name = 'employee_monthly_strikes'
      and column_name = 'strike_half_day_dates'
  ) then
    execute $migrate$
      update employee_monthly_strikes
      set strike_items = coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'date', to_char(d, 'YYYY-MM-DD'),
              'reason', 'Late strike: every 3rd late day of the month becomes a Half Day'
            )
            order by d
          )
          from unnest(coalesce(strike_half_day_dates, '{}'::date[])) as d
        ),
        '[]'::jsonb
      )
      where coalesce(jsonb_array_length(strike_items), 0) = 0
    $migrate$;
  end if;
end
$$;

alter table employee_monthly_strikes
  drop column if exists strike_half_day_dates;

create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_monthly_strikes_touch on employee_monthly_strikes;
create trigger trg_monthly_strikes_touch
  before update on employee_monthly_strikes
  for each row execute function touch_updated_at();
