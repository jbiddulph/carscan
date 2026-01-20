-- Create extensions needed for UUID generation.
create extension if not exists "pgcrypto";

-- Table to store DVLA scan results.
create table if not exists public.carscan_vehicles (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id text not null,
  plate text not null,
  vehicle_data jsonb not null,
  ocr_confidence numeric,
  location jsonb,
  snapshot_path text,
  raw_snapshot_path text
);

create index if not exists carscan_vehicles_user_id_idx on public.carscan_vehicles (user_id);
create index if not exists carscan_vehicles_plate_idx on public.carscan_vehicles (plate);
create index if not exists carscan_vehicles_created_at_idx on public.carscan_vehicles (created_at);

alter table public.carscan_vehicles enable row level security;

-- Authenticated users can insert and read their own rows.
do $$
begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'carscan_vehicles'
      and policyname = 'carscan_vehicles_insert_own'
  ) then
    execute 'drop policy "carscan_vehicles_insert_own" on public.carscan_vehicles';
  end if;
end $$;
create policy "carscan_vehicles_insert_own"
  on public.carscan_vehicles
  for insert
  to authenticated
  with check (user_id = auth.uid()::text);

do $$
begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'carscan_vehicles'
      and policyname = 'carscan_vehicles_select_own'
  ) then
    execute 'drop policy "carscan_vehicles_select_own" on public.carscan_vehicles';
  end if;
end $$;
create policy "carscan_vehicles_select_own"
  on public.carscan_vehicles
  for select
  to authenticated
  using (user_id = auth.uid()::text);

-- Table grants for authenticated users (RLS still applies).
revoke all on table public.carscan_vehicles from anon, authenticated;
grant select, insert, update, delete on table public.carscan_vehicles to anon, authenticated;

-- Storage bucket for images.
insert into storage.buckets (id, name, public)
values ('carscan', 'carscan', false)
on conflict (id) do nothing;

-- Allow authenticated users to read their own files under carscan/<user_id>/.
do $$
begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'carscan_storage_read_own'
  ) then
    execute 'drop policy "carscan_storage_read_own" on storage.objects';
  end if;
end $$;
create policy "carscan_storage_read_own"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'carscan'
    and split_part(name, '/', 2) = auth.uid()::text
  );

-- Allow authenticated users to upload/update/delete their own files under carscan/<user_id>/.
do $$
begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'carscan_storage_insert_own'
  ) then
    execute 'drop policy "carscan_storage_insert_own" on storage.objects';
  end if;
end $$;
create policy "carscan_storage_insert_own"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'carscan'
    and split_part(name, '/', 2) = auth.uid()::text
  );

do $$
begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'carscan_storage_update_own'
  ) then
    execute 'drop policy "carscan_storage_update_own" on storage.objects';
  end if;
end $$;
create policy "carscan_storage_update_own"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'carscan'
    and split_part(name, '/', 2) = auth.uid()::text
  )
  with check (
    bucket_id = 'carscan'
    and split_part(name, '/', 2) = auth.uid()::text
  );

do $$
begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'carscan_storage_delete_own'
  ) then
    execute 'drop policy "carscan_storage_delete_own" on storage.objects';
  end if;
end $$;
create policy "carscan_storage_delete_own"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'carscan'
    and split_part(name, '/', 2) = auth.uid()::text
  );
