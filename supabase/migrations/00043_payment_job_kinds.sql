-- 00043 — two notification kinds, on their own
--
-- `alter type ... add value` commits with the statement, but a *use* of the new label in the same transaction is
-- refused by PostgreSQL ("unsafe use of new value"). A file that both adds an enum label and inserts a catalogue
-- row for it therefore works on a database that already has the label — which is every database where the
-- migration has run once — and fails on a fresh one. That is the worst class of migration bug: invisible until
-- the day it matters.
--
-- So this file adds the labels and nothing else; `00044_payment_jobs.sql` uses them. Same split as `00019` and
-- `00021`, where the enum values also live alone.

alter type public.notification_kind add value if not exists 'payment_reminder';
alter type public.notification_kind add value if not exists 'agent_settlement_due';
