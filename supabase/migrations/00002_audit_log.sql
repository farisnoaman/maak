-- 00002 — append-only audit trail
--
-- Every write command inserts here in the SAME transaction (ADR-0001 §verification):
-- an action without a trace cannot commit.

create table audit.log (
  id            bigint generated always as identity primary key,
  actor_id      uuid,
  action        text not null,
  entity_type   text not null,
  entity_id     text,
  before        jsonb,
  after         jsonb,
  reason        text,
  request_id    text,
  ip            inet,
  outcome       text not null default 'success'
                  check (outcome in ('success', 'denied', 'failed')),
  created_at    timestamptz not null default now()
);

create index audit_log_actor_idx on audit.log (actor_id, created_at desc);
create index audit_log_entity_idx on audit.log (entity_type, entity_id, created_at desc);
create index audit_log_action_idx on audit.log (action, created_at desc);

comment on table audit.log is 'Append-only. No UPDATE/DELETE grants exist for any role.';

-- Append-only enforcement: even a superuser mistake is caught at the trigger level.
create or replace function audit.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'AUDIT_IMMUTABLE: audit.log is append-only'
    using errcode = '42501';
end;
$$;

create trigger audit_log_no_update
  before update or delete on audit.log
  for each row execute function audit.reject_mutation();

create trigger audit_log_no_truncate
  before truncate on audit.log
  for each statement execute function audit.reject_mutation();

revoke all on audit.log from anon, authenticated;
grant insert, select on audit.log to service_role;
revoke update, delete, truncate on audit.log from public;

-- Convenience writer so commands never hand-roll the column list.
create or replace function app.write_audit(
  p_actor uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_before jsonb default null,
  p_after jsonb default null,
  p_reason text default null,
  p_request_id text default null,
  p_ip inet default null,
  p_outcome text default 'success'
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into audit.log (actor_id, action, entity_type, entity_id, before, after, reason, request_id, ip, outcome)
  values (p_actor, p_action, p_entity_type, p_entity_id, p_before, p_after, p_reason, p_request_id, p_ip, p_outcome);
$$;

revoke all on function app.write_audit(uuid, text, text, text, jsonb, jsonb, text, text, inet, text) from public, anon, authenticated;
grant execute on function app.write_audit(uuid, text, text, text, jsonb, jsonb, text, text, inet, text) to service_role;
