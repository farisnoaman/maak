-- 00005 — rate limiting (multi-instance safe)
--
-- Edge functions scale horizontally, so a per-process counter is useless: two instances would
-- each allow the full quota. The window lives in one row per (actor, action) and is advanced
-- atomically, which is the cheapest correct implementation on Postgres.

create table app.rate_limits (
  actor_id       uuid not null,
  action         text not null,
  window_started timestamptz not null default now(),
  used           integer not null default 0 check (used >= 0),
  primary key (actor_id, action)
);

comment on table app.rate_limits is 'Sliding-window counters. Pruned by app.prune_rate_limits().';

alter table app.rate_limits enable row level security;

-- No client access at all: only the gateway (service role) may read or write these rows.
revoke all on app.rate_limits from anon, authenticated;

create or replace function app.consume_rate_limit(
  p_actor uuid,
  p_action text,
  p_limit integer,
  p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row app.rate_limits;
  v_elapsed double precision;
begin
  if p_actor is null or p_action is null or p_limit is null or p_window_seconds is null then
    raise exception 'VALIDATION_FAILED: rate limit arguments are required' using errcode = '22023';
  end if;
  if p_limit < 1 or p_window_seconds < 1 then
    raise exception 'VALIDATION_FAILED: limit and window must be positive' using errcode = '22023';
  end if;

  insert into app.rate_limits (actor_id, action, window_started, used)
  values (p_actor, p_action, now(), 1)
  on conflict (actor_id, action) do update
    set used = case
                 when app.rate_limits.window_started < now() - make_interval(secs => p_window_seconds)
                   then 1
                 else app.rate_limits.used + 1
               end,
        window_started = case
                 when app.rate_limits.window_started < now() - make_interval(secs => p_window_seconds)
                   then now()
                 else app.rate_limits.window_started
               end
  returning * into v_row;

  v_elapsed := extract(epoch from (now() - v_row.window_started));

  return jsonb_build_object(
    'used', v_row.used,
    'elapsed_seconds', v_elapsed,
    'limit', p_limit,
    'window_seconds', p_window_seconds
  );
end;
$$;

revoke all on function app.consume_rate_limit(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function app.consume_rate_limit(uuid, text, integer, integer) to service_role;

-- PostgREST exposes the public schema; these thin wrappers let the edge call them by name
-- without granting access to the `app` schema directly.
create or replace function public.app_consume_rate_limit(
  p_actor uuid,
  p_action text,
  p_limit integer,
  p_window_seconds integer
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select app.consume_rate_limit(p_actor, p_action, p_limit, p_window_seconds);
$$;

revoke all on function public.app_consume_rate_limit(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.app_consume_rate_limit(uuid, text, integer, integer) to service_role;

create or replace function public.app_write_audit(
  p_actor uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_before jsonb,
  p_after jsonb,
  p_reason text,
  p_request_id text,
  p_ip inet,
  p_outcome text
)
returns void
language sql
security definer
set search_path = ''
as $$
  select app.write_audit(
    p_actor, p_action, p_entity_type, p_entity_id,
    p_before, p_after, p_reason, p_request_id, p_ip, p_outcome
  );
$$;

revoke all on function public.app_write_audit(uuid, text, text, text, jsonb, jsonb, text, text, inet, text)
  from public, anon, authenticated;
grant execute on function public.app_write_audit(uuid, text, text, text, jsonb, jsonb, text, text, inet, text)
  to service_role;

-- Housekeeping: old windows carry no information and would grow without bound.
create or replace function app.prune_rate_limits()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from app.rate_limits
  where window_started < now() - interval '1 day';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function app.prune_rate_limits() from public, anon, authenticated;
grant execute on function app.prune_rate_limits() to service_role;
