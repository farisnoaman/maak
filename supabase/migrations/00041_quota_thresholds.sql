-- 00041 — one rule for "you are close to your quota"
--
-- The report has carried this for a phase as "a product call rather than a documentation one", and the call
-- is this: **the 80 % notice is universal, and it arrives when the next unit would cross it.**
--
-- The two paths that used to decide disagreed twice. `app.quota_state()` set `warning` only for plans whose
-- `soft_limit` is true (Pro, Business), so a Basic operator creating the trip that would take them to 80 %
-- of a hard limit got silence — while the monthly job mailed them about it. And the boundary itself was
-- computed two ways: the response used `(used + 1) * 5 >= limit * 4` (the *next* trip), the job used
-- `used * 100 / limit >= 80` (the current usage). At a limit of 50 those are `used = 39` and `used = 40`.
--
-- Now `threshold` is a field of the state, computed once and consumed by both callers: 100 at the limit, 80
-- when the next unit crosses 80 %, null otherwise. `warning` is `threshold is not null`, plan-independent.
-- `soft` survives with the meaning it should always have had — overage is charged — because that is a fact
-- about the plan, not about proximity, and it is the reason the notice must not be gated on it.
--
-- Nothing about *blocking* moves: `app.assert_quota` still refuses at 100 % on every plan, soft or not.

create or replace function app.quota_state(
  p_owner_user uuid,
  p_owner_org uuid,
  p_metric text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plan public.plan_code;
  v_limit integer;
  v_soft boolean;
  v_override integer;
  v_has_override boolean := false;
  v_used integer;
  v_effective_limit integer;
  v_threshold integer;
begin
  v_plan := app.owner_plan(p_owner_user, p_owner_org);

  select l.limit_value, coalesce(p.soft_limit, false)
  into v_limit, v_soft
  from public.plan_limits l
  join public.plans p on p.code = l.plan_code
  where l.plan_code = v_plan and l.metric = p_metric;

  if not found then
    raise exception 'VALIDATION_FAILED: unknown quota metric %', p_metric using errcode = '22023';
  end if;

  select o.limit_value into v_override
    from public.quota_overrides o
   where o.metric = p_metric
     and o.revoked_at is null
     and (o.expires_at is null or o.expires_at > now())
     and (case when p_owner_org is not null then o.owner_org_id = p_owner_org
               else o.owner_user_id = p_owner_user end)
   -- The most generous live override wins: two support grants should not fight, and the later one is the one
   -- somebody meant.
   order by o.limit_value desc nulls first, o.created_at desc
   limit 1;
  v_has_override := found;

  v_used := app.quota_usage(p_owner_user, p_owner_org, p_metric);

  v_effective_limit := case when v_has_override then v_override else v_limit end;

  -- One decision, and it is this one. 100 at the limit; 80 when *the next unit* would cross 80 %, because a
  -- notice is only actionable while there is still something to do about it; null otherwise.
  --
  -- It is deliberately not gated on `soft`. `soft` answers "is overage charged?", which is a different
  -- question from "are you close?", and gating the notice on it meant a Basic operator — at 80 % of a hard
  -- limit, two trips from being blocked — was the one person never told. `warning` is now exactly "there is
  -- a threshold", so a caller cannot accidentally re-derive the boundary.
  v_threshold := case
    when v_effective_limit is null or v_effective_limit <= 0 then null
    when v_used >= v_effective_limit then 100
    when (v_used + 1) * 5 >= v_effective_limit * 4 then 80
    else null
  end;

  return jsonb_build_object(
    'metric', p_metric,
    'plan', v_plan,
    'limit', v_effective_limit,
    'plan_limit', v_limit,
    'override', v_has_override,
    'used', v_used,
    'soft', v_soft,
    'threshold', v_threshold,
    'warning', v_threshold is not null
  );
end;
$$;

create or replace function public.cmd_notify_quota_thresholds(
  p_actor uuid,
  p_period text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period text := coalesce(
    p_period, to_char(now() at time zone app.notification_timezone(), 'YYYY-MM')
  );
  v_owner record;
  v_metric text;
  v_state jsonb;
  v_limit integer;
  v_used integer;
  v_pct integer;
  v_threshold integer;
  v_sent integer := 0;
  v_recipients uuid[];
  v_recipient uuid;
  v_metrics text[];
begin
  select array_agg(distinct l.metric order by l.metric) into v_metrics from public.plan_limits l;

  for v_owner in
    select s.owner_user_id as user_id, s.owner_org_id as org_id
      from public.subscriptions s
     where s.status in ('trialing', 'active', 'past_due', 'grace')
     order by s.created_at
  loop
    v_recipients := array[]::uuid[];
    if v_owner.org_id is not null then
      select coalesce(array_agg(m.user_id), array[]::uuid[]) into v_recipients
        from public.organization_members m
       where m.org_id = v_owner.org_id and m.role in ('owner', 'manager') and m.status = 'active';
    end if;
    if v_owner.user_id is not null then
      v_recipients := v_recipients || v_owner.user_id;
    end if;

    foreach v_metric in array v_metrics loop
      v_state := app.quota_state(v_owner.user_id, v_owner.org_id, v_metric);
      v_limit := (v_state ->> 'limit')::integer;
      v_used := (v_state ->> 'used')::integer;

      continue when v_limit is null or v_limit = 0;

      -- The threshold is the state function's decision, never a second copy of the arithmetic. The copy this
      -- replaces disagreed with the create-trip response twice over: it ignored `soft`, and it tested the
      -- *current* usage against 80 % where the response tests the next unit — at a limit of 50 that is two
      -- notifications for one boundary, one of them a month late or a month early.
      v_threshold := (v_state ->> 'threshold')::integer;
      continue when v_threshold is null;
      v_pct := (v_used * 100) / v_limit;

      foreach v_recipient in array v_recipients loop
        if (app.enqueue_notification(
          v_recipient,
          'quota_threshold',
          case when v_threshold >= 100
            then 'notifications.quotaReached'
            else 'notifications.quotaWarning'
          end,
          jsonb_build_object(
            'metric', v_metric,
            'used', v_used,
            'limit', v_limit,
            'percent', least(v_pct, 100),
            'threshold', v_threshold,
            'period', v_period
          ),
          '/operator/billing',
          'quota:' || coalesce(v_owner.org_id, v_owner.user_id)::text || ':'
            || v_metric || ':' || v_threshold::text || ':' || v_period
        ) ->> 'created')::boolean then
          v_sent := v_sent + 1;
        end if;
      end loop;
    end loop;
  end loop;

  return jsonb_build_object('period', v_period, 'sent', v_sent);
end;
$$;

comment on function app.quota_state(uuid, uuid, text) is
  'Plan limit gate state. `threshold` (100 | 80 | null) is the single close-to-the-limit decision for every '
  'plan and for every caller; `warning` is `threshold is not null`; `soft` means overage is charged.';

comment on function public.cmd_notify_quota_thresholds(uuid, text) is
  'Monthly quota notice. Sends whatever `app.quota_state()` says the threshold is — no arithmetic of its own.';
