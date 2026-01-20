-- Diagnostic and fix script for carscan_vehicles permissions.
-- Run this in Supabase SQL Editor when troubleshooting.

-- Check table ownership.
select
  schemaname,
  tablename,
  tableowner
from pg_tables
where tablename = 'carscan_vehicles';

-- Check current grants.
select
  grantee,
  table_schema,
  table_name,
  privilege_type
from information_schema.table_privileges
where table_schema = 'public'
  and table_name = 'carscan_vehicles'
  and grantee in ('anon', 'authenticated')
order by grantee, privilege_type;

-- Forcefully revoke and re-grant to refresh permissions.
revoke all on table public.carscan_vehicles from anon, authenticated;
grant select, insert, update, delete on table public.carscan_vehicles to anon, authenticated;

-- Verify grants were applied.
select
  grantee,
  table_schema,
  table_name,
  privilege_type
from information_schema.table_privileges
where table_schema = 'public'
  and table_name = 'carscan_vehicles'
  and grantee in ('anon', 'authenticated')
order by grantee, privilege_type;
