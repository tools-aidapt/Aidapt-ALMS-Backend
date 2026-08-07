-- Many-to-many employee ↔ team membership.
-- employees.team_id is kept as a denormalised primary (first membership) for
-- older clients; membership itself lives in employee_teams.
-- Safe to re-run.

create table if not exists employee_teams (
  employee_id uuid not null references employees (id) on delete cascade,
  team_id     uuid not null references teams (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (employee_id, team_id)
);

create index if not exists employee_teams_team_idx on employee_teams (team_id);
create index if not exists employee_teams_employee_idx on employee_teams (employee_id);

-- Backfill from legacy single team_id.
insert into employee_teams (employee_id, team_id)
select e.id, e.team_id
  from employees e
 where e.team_id is not null
on conflict do nothing;
