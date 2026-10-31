-- MistWalk Supabase schema
-- Run this once in the Supabase SQL Editor, then promote yourself to admin:
--
--   update public.mistwalk_members
--      set role = 'admin', status = 'approved', decided_at = now()
--    where email = 'you@example.com';
--
-- New sign-ins are created as pending members and cannot read or write any
-- backup until an admin approves them or they redeem an invite code.

/* ------------------------------------------------------------------------- */
/* Members                                                                   */
/* ------------------------------------------------------------------------- */

create table if not exists public.mistwalk_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  role text not null default 'member'
    check (role in ('admin', 'member')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users (id) on delete set null
);

alter table public.mistwalk_members enable row level security;

create or replace function public.mistwalk_is_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.mistwalk_members m
     where m.user_id = uid
       and m.role = 'admin'
       and m.status = 'approved'
  );
$$;

create or replace function public.mistwalk_is_approved(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.mistwalk_members m
     where m.user_id = uid
       and m.status = 'approved'
  );
$$;

revoke all on function public.mistwalk_is_admin(uuid) from public, anon;
revoke all on function public.mistwalk_is_approved(uuid) from public, anon;
grant execute on function public.mistwalk_is_admin(uuid) to authenticated;
grant execute on function public.mistwalk_is_approved(uuid) to authenticated;

drop policy if exists "Members read their own row" on public.mistwalk_members;
drop policy if exists "Members read own or admin" on public.mistwalk_members;
create policy "Members read own or admin"
  on public.mistwalk_members
  for select
  to authenticated
  using (user_id = auth.uid() or public.mistwalk_is_admin(auth.uid()));

revoke all on public.mistwalk_members from anon;
grant select on public.mistwalk_members to authenticated;

-- Every new auth user starts as a pending member.
create or replace function public.mistwalk_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.mistwalk_members (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists mistwalk_on_auth_user_created on auth.users;
create trigger mistwalk_on_auth_user_created
  after insert on auth.users
  for each row execute function public.mistwalk_handle_new_user();

-- Backfill accounts that existed before this schema was installed.
insert into public.mistwalk_members (user_id, email)
select id, email from auth.users
on conflict (user_id) do nothing;

-- Admin-only status changes. Admins cannot change their own access.
create or replace function public.mistwalk_set_member_status(target uuid, decision text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.mistwalk_is_admin(auth.uid()) then
    raise exception 'Only the owner can change access.';
  end if;
  if decision not in ('pending', 'approved', 'rejected') then
    raise exception 'Invalid access status.';
  end if;
  if target = auth.uid() then
    raise exception 'You cannot change your own access.';
  end if;
  update public.mistwalk_members
     set status = decision,
         decided_at = now(),
         decided_by = auth.uid()
   where user_id = target;
  if not found then
    raise exception 'Member not found.';
  end if;
end;
$$;

revoke all on function public.mistwalk_set_member_status(uuid, text) from public, anon;
grant execute on function public.mistwalk_set_member_status(uuid, text) to authenticated;

/* ------------------------------------------------------------------------- */
/* Invites                                                                   */
/* ------------------------------------------------------------------------- */

create table if not exists public.mistwalk_invites (
  code text primary key,
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_by uuid references auth.users (id) on delete set null,
  used_at timestamptz
);

alter table public.mistwalk_invites enable row level security;

drop policy if exists "Admins read invites" on public.mistwalk_invites;
create policy "Admins read invites"
  on public.mistwalk_invites
  for select
  to authenticated
  using (public.mistwalk_is_admin(auth.uid()));

revoke all on public.mistwalk_invites from anon;
grant select on public.mistwalk_invites to authenticated;

create or replace function public.mistwalk_create_invite(valid_days integer default 7)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  fresh_code text;
  span integer := greatest(1, least(coalesce(valid_days, 7), 30));
begin
  if not public.mistwalk_is_admin(auth.uid()) then
    raise exception 'Only the owner can create invites.';
  end if;
  fresh_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  insert into public.mistwalk_invites (code, created_by, expires_at)
  values (fresh_code, auth.uid(), now() + make_interval(days => span));
  return fresh_code;
end;
$$;

revoke all on function public.mistwalk_create_invite(integer) from public, anon;
grant execute on function public.mistwalk_create_invite(integer) to authenticated;

create or replace function public.mistwalk_redeem_invite(invite_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  found_invite public.mistwalk_invites%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in before redeeming an invite.';
  end if;

  select *
    into found_invite
    from public.mistwalk_invites
   where code = upper(trim(invite_code))
   for update;

  if not found then
    raise exception 'That invite code was not found.';
  end if;
  if found_invite.used_by is not null then
    raise exception 'That invite code was already used.';
  end if;
  if found_invite.expires_at < now() then
    raise exception 'That invite code has expired.';
  end if;

  update public.mistwalk_invites
     set used_by = auth.uid(), used_at = now()
   where code = found_invite.code;

  insert into public.mistwalk_members (user_id, email, status, decided_at, decided_by)
  values (auth.uid(), null, 'approved', now(), found_invite.created_by)
  on conflict (user_id) do update
    set status = 'approved',
        decided_at = now(),
        decided_by = found_invite.created_by;

  return 'approved';
end;
$$;

revoke all on function public.mistwalk_redeem_invite(text) from public, anon;
grant execute on function public.mistwalk_redeem_invite(text) to authenticated;

/* ------------------------------------------------------------------------- */
/* Backups                                                                   */
/* ------------------------------------------------------------------------- */

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
  using (public.mistwalk_is_approved(auth.uid()) and auth.uid() = user_id);

drop policy if exists "Users insert their own backup" on public.mistwalk_backups;
create policy "Users insert their own backup"
  on public.mistwalk_backups
  for insert
  to authenticated
  with check (public.mistwalk_is_approved(auth.uid()) and auth.uid() = user_id);

drop policy if exists "Users update their own backup" on public.mistwalk_backups;
create policy "Users update their own backup"
  on public.mistwalk_backups
  for update
  to authenticated
  using (public.mistwalk_is_approved(auth.uid()) and auth.uid() = user_id)
  with check (public.mistwalk_is_approved(auth.uid()) and auth.uid() = user_id);

drop policy if exists "Users delete their own backup" on public.mistwalk_backups;
create policy "Users delete their own backup"
  on public.mistwalk_backups
  for delete
  to authenticated
  using (public.mistwalk_is_approved(auth.uid()) and auth.uid() = user_id);

revoke all on public.mistwalk_backups from anon;
grant select, insert, update, delete on public.mistwalk_backups to authenticated;
