-- ---------------------------------------------------------------------------
-- 00021 — the words a running trip needs
--
-- `in_progress` and three event kinds. Nothing else, on purpose: Postgres refuses to *use* a value it
-- added in the same transaction, and every migration here runs in one transaction (that is what makes a
-- half-applied migration impossible). So the vocabulary lands first and `00022` — which needs these
-- labels in a check constraint — lands after it.
-- ---------------------------------------------------------------------------

alter type public.trip_status add value if not exists 'in_progress';

alter type public.trip_event_kind add value if not exists 'started';
alter type public.trip_event_kind add value if not exists 'stop_reached';
alter type public.trip_event_kind add value if not exists 'ended';
