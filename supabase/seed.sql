-- Seed: idempotent, safe to run repeatedly.
--
-- Phase 0 intentionally seeds nothing that requires an auth user, because profiles are created by
-- the `on_auth_user_created` trigger and must reference `auth.users` (no fake rows, no FK violations).
--
-- Demo accounts are created through the Auth admin API by `scripts/seed-demo.mjs` in Phase 1.
-- Geography (22 governorates, ~333 districts, POIs) is seeded in Phase 2.
-- Plans and commission rules are seeded in Phase 10.

do $$
begin
  raise notice 'Maak seed: nothing to do in Phase 0 (idempotent).';
end $$;
