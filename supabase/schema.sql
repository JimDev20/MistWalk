create table if not exists public.mistwalk_backups (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null,
  saved_at bigint not null,
  updated_at timestamptz not null default now()
);

alter table public.mistwalk_backups enable row level security;

drop policy if exists "Users read their own backup" on public.mistwalk_backups;
create policy "Users read their own backup"
  on public.mistwalk_backups
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users insert their own backup" on public.mistwalk_backups;
create policy "Users insert their own backup"
  on public.mistwalk_backups
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users update their own backup" on public.mistwalk_backups;
create policy "Users update their own backup"
  on public.mistwalk_backups
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users delete their own backup" on public.mistwalk_backups;
create policy "Users delete their own backup"
  on public.mistwalk_backups
  for delete
  to authenticated
  using (auth.uid() = user_id);

revoke all on public.mistwalk_backups from anon;
grant select, insert, update, delete on public.mistwalk_backups to authenticated;
