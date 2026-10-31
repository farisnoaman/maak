-- ---------------------------------------------------------------------------
-- 00026 — Phase 8, part zero: the two notification kinds maintenance needs
--
-- Migration 00021 established the rule the hard way: Postgres refuses to *use* an enum value added in
-- the same transaction that added it, and every migration here runs inside one. The reminder job writes
-- `vehicle_maintenance_due` / `vehicle_maintenance_overdue`, so those values have to exist in a
-- transaction of their own. 00027 is the rest of Phase 8.
--
-- Values only. No table, no function, no behaviour — a migration that cannot fail halfway.
-- ---------------------------------------------------------------------------

alter type public.notification_kind add value if not exists 'vehicle_maintenance_due';
alter type public.notification_kind add value if not exists 'vehicle_maintenance_overdue';
