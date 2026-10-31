-- ---------------------------------------------------------------------------
-- 00028 — Phase 8.1: one more notification kind, in its own transaction
--
-- Same rule as 00026: Postgres will not let a transaction *use* an enum value it has just added, and
-- `cmd_log_fuel` now tells the owner that a van is drinking more than it used to. The value has to exist
-- before the function that writes it can run, so it gets a migration where nothing else can fail.
--
-- Values only. No table, no function, no behaviour.
-- ---------------------------------------------------------------------------

alter type public.notification_kind add value if not exists 'vehicle_fuel_anomaly';
