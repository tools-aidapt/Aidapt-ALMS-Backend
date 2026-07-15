-- Supabase Custom Access Token Auth Hook.
-- Injects the employee's app role into every access token as the `app_role`
-- claim, so the API can read the role straight from the JWT and skip a
-- per-request DB lookup (see src/middleware/auth.js fast path).
--
-- Apply this SQL, then ENABLE it in the dashboard:
--   Authentication > Hooks > Custom Access Token > select public.custom_access_token_hook
--
-- Note: role travels in the token, so a role change propagates at the next token
-- refresh (Supabase access tokens are short-lived, ~1h), not instantly.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims jsonb;
  emp_role text;
begin
  select role into emp_role
  from public.employees
  where id = (event->>'user_id')::uuid;

  claims := coalesce(event->'claims', '{}'::jsonb);

  -- Only provisioned employees get a role claim; unprovisioned users fall back
  -- to the API's DB lookup (which returns 403 NOT_PROVISIONED).
  if emp_role is not null then
    claims := jsonb_set(claims, '{app_role}', to_jsonb(emp_role));
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- The Auth server runs the hook as the supabase_auth_admin role.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
grant select on table public.employees to supabase_auth_admin;

-- Keep it out of reach of normal API roles.
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
