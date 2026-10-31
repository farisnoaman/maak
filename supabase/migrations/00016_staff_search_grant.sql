-- ---------------------------------------------------------------------------
-- 00016 — let staff actually search trips
--
-- `staff_search_trips` shipped in 00014 inside the block that revokes the trip *commands* from `anon`
-- and `authenticated`, so it was reachable only by `service_role`. Reads in this app never use the
-- service role (see docs/security model), which made the function dead: `/staff/trips?q=…` answered
-- `42501 permission denied for function staff_search_trips` and the console rendered "forbidden" for
-- the very people it exists for.
--
-- The function authorises itself — it raises `42501` unless `app.is_platform_staff(p_actor)` — so the
-- grant is safe: an ordinary signed-in user gets the same error the dev console showed, an anonymous
-- visitor does not even reach it.
--
-- The pgTAP suite could not catch this because it runs as the database superuser and never asks Postgres
-- whether a role may execute anything; 0007 now asserts the grants directly.
-- ---------------------------------------------------------------------------

revoke all on function public.staff_search_trips(uuid, jsonb, integer) from public, anon;
grant execute on function public.staff_search_trips(uuid, jsonb, integer) to authenticated, service_role;
