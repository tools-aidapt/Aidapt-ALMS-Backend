-- Teams + employee team assignment.
-- Run in Supabase SQL Editor. Safe to re-run.

create table if not exists teams (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  lead_id    uuid references employees (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table employees
  add column if not exists team_id uuid references teams (id) on delete set null;

create index if not exists employees_team_idx on employees (team_id);
create index if not exists teams_lead_idx on teams (lead_id);

-- Seed the two known teams (idempotent by name).
insert into teams (name)
values ('Operations Team'), ('Data Team')
on conflict (name) do nothing;

-- Assign leads by known emails / names.
update teams t
set lead_id = e.id
from employees e
where t.name = 'Operations Team'
  and (
    lower(e.email) = 'm.ateeb@aidapt.co'
    or e.name ilike '%Ateeb%'
  );

update teams t
set lead_id = e.id
from employees e
where t.name = 'Data Team'
  and (
    lower(e.email) = 's.irtaza@aidapt.co'
    or e.name ilike '%Irtaza%'
  );

-- Operations Team: Ateeb (lead), Maaz, Abdul Rehman, Umer Yousaf, Huzaifa
update employees e
set team_id = t.id
from teams t
where t.name = 'Operations Team'
  and (
    e.name ilike '%Ateeb%'
    or e.name ilike '%Maaz%Ahmed%'
    or e.name ilike '%Abdul%Rehman%'
    or e.name ilike '%Umer%Yousaf%'
    or e.name ilike '%Huzaifa%'
  );

-- Data Team: Irtaza (lead), Ali Siddiqui, Fiza Sheikh
update employees e
set team_id = t.id
from teams t
where t.name = 'Data Team'
  and (
    e.name ilike '%Irtaza%'
    or e.name ilike '%Ali%Siddiqui%'
    or e.name ilike '%Fiza%'
  );
