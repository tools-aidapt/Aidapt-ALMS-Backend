-- Backfill only — no DDL.
-- Run this alone in Supabase SQL Editor after employee_monthly_strikes already exists.
-- Avoid running it at the same time as ALTER/DROP TRIGGER, Table Editor, or a busy API.
--
-- Merges:
--   1) every 3rd late day in the month
--   2) immediate strike when check-in is > 30 minutes after shift start (Asia/Karachi)

with employee_months as (
  select distinct
    employee_id,
    to_char(date, 'YYYY-MM') as year_month
  from attendance_punches
),
day_flags as (
  select
    p.employee_id,
    p.date,
    to_char(p.date, 'YYYY-MM') as year_month,
    coalesce(p.is_late, false) as is_late,
    p.check_in_time,
    to_char(p.check_in_time at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI') as check_in_time_pkt,
    case
      when p.check_in_time is not null
       and s.start_time is not null
       and s.start_time ~ '^\d{1,2}:\d{2}'
      then (
        extract(hour from (p.check_in_time at time zone 'Asia/Karachi'))::int * 60
        + extract(minute from (p.check_in_time at time zone 'Asia/Karachi'))::int
      ) > (
        split_part(s.start_time, ':', 1)::int * 60
        + split_part(s.start_time, ':', 2)::int
        + 30
      )
      else false
    end as is_immediate_strike
  from attendance_punches p
  left join employees e on e.id = p.employee_id
  left join shifts s on s.id = e.assigned_shift_id
),
late_days as (
  select
    employee_id,
    year_month,
    date,
    check_in_time,
    check_in_time_pkt,
    row_number() over (
      partition by employee_id, year_month
      order by date
    ) as late_ordinal
  from day_flags
  where is_late = true
),
monthly_strikes as (
  select
    employee_id,
    year_month,
    date,
    check_in_time,
    check_in_time_pkt,
    (
      'Late strike: ' ||
      late_ordinal ||
      case
        when late_ordinal % 100 between 11 and 13 then 'th'
        when late_ordinal % 10 = 1 then 'st'
        when late_ordinal % 10 = 2 then 'nd'
        when late_ordinal % 10 = 3 then 'rd'
        else 'th'
      end ||
      ' late day of the month becomes a Half Day'
    ) as reason
  from late_days
  where late_ordinal % 3 = 0
),
immediate_strikes as (
  select
    employee_id,
    year_month,
    date,
    check_in_time,
    check_in_time_pkt,
    'Immediate strike: arrived more than 30 minutes after shift start'::text as reason
  from day_flags
  where is_immediate_strike = true
),
merged_strikes as (
  select
    coalesce(i.employee_id, m.employee_id) as employee_id,
    coalesce(i.year_month, m.year_month) as year_month,
    coalesce(i.date, m.date) as date,
    coalesce(i.reason, m.reason) as reason,
    coalesce(i.check_in_time, m.check_in_time) as check_in_time,
    coalesce(i.check_in_time_pkt, m.check_in_time_pkt) as check_in_time_pkt
  from monthly_strikes m
  full outer join immediate_strikes i
    on i.employee_id = m.employee_id
   and i.date = m.date
),
monthly_rollup as (
  select
    em.employee_id,
    em.year_month,
    (
      select count(*)::integer
      from day_flags df
      where df.employee_id = em.employee_id
        and df.year_month = em.year_month
        and df.is_late = true
    ) as late_count,
    coalesce(
      (
        select count(*)::integer
        from merged_strikes ms
        where ms.employee_id = em.employee_id
          and ms.year_month = em.year_month
      ),
      0
    ) as strike_count,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'date', to_char(ms.date, 'YYYY-MM-DD'),
            'reason', ms.reason,
            'checkInTime', ms.check_in_time,
            'checkInTimePkt', ms.check_in_time_pkt
          )
          order by ms.date
        )
        from merged_strikes ms
        where ms.employee_id = em.employee_id
          and ms.year_month = em.year_month
      ),
      '[]'::jsonb
    ) as strike_items
  from employee_months em
)
insert into employee_monthly_strikes (
  employee_id,
  year_month,
  late_count,
  strike_count,
  strike_items
)
select
  employee_id,
  year_month,
  late_count,
  strike_count,
  strike_items
from monthly_rollup
on conflict (employee_id, year_month) do update set
  late_count = excluded.late_count,
  strike_count = excluded.strike_count,
  strike_items = excluded.strike_items,
  updated_at = now();
