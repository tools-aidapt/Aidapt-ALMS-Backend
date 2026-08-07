-- Leadership team: company-wide people data access (profiles, personal details,
-- attendance). Membership is checked in the API (not a new auth role).
-- Anyone in employee_teams for Leadership OR set as lead_id gets company-wide
-- data visibility (same read level as HR Admin for people data).
-- A person may belong to Leadership AND other teams via employee_teams.
-- Safe to re-run.

insert into teams (name)
values ('Leadership')
on conflict (name) do nothing;

-- EXAMPLE: make CEO lead of Leadership (keeps other team memberships):
--
-- update teams t
-- set lead_id = e.id
-- from employees e
-- where t.name = 'Leadership'
--   and lower(e.email) = 'ceo@aidapt.co';
--
-- EXAMPLE: also put them on Leadership (multi-team — does not clear other teams):
--
-- insert into employee_teams (employee_id, team_id)
-- select e.id, t.id
--   from employees e
--   cross join teams t
--  where lower(e.email) = 'ceo@aidapt.co'
--    and t.name = 'Leadership'
-- on conflict do nothing;
