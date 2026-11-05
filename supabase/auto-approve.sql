-- MistWalk owner auto-approval
--
-- Run this once in the Supabase SQL Editor after supabase/schema.sql.
-- It keeps the owner allowlist server-side, so no personal email is committed.
--
-- Setup:
--   1. Run this file.
--   2. Add each owner email in the SQL Editor (never commit this statement):
--
--        insert into public.mistwalk_owner_emails (email)
--        values ('you@example.com')
--        on conflict (email) do nothing;
--
--   3. Approve owner accounts that signed in before the allowlist existed:
--
--        select public.mistwalk_sync_owner_emails();
--
-- Allowlisted accounts are created as approved admins on first sign-in.
-- Every other account keeps the normal pending-approval flow.

/* ------------------------------------------------------------------------- */
/* Owner allowlist                                                           */
/* ------------------------------------------------------------------------- */

create table if not exists public.mistwalk_owner_emails (
  email text primary key check (position('@' in email) > 1)
);

create unique index if not exists mistwalk_owner_emails_lower_email_idx
  on public.mistwalk_owner_emails (lower(email));

alter table public.mistwalk_owner_emails enable row level security;
revoke all on public.mistwalk_owner_emails from public, anon, authenticated;

/* ------------------------------------------------------------------------- */
/* Signup trigger                                                            */
/* ------------------------------------------------------------------------- */

create or replace function public.mistwalk_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_match boolean;
begin
  select exists (
    select 1
      from public.mistwalk_owner_emails o
     where lower(o.email) = lower(coalesce(new.email, ''))
  )
  into owner_match;

  insert into public.mistwalk_members (user_id, email, status, role, decided_at)
  values (
    new.id,
    new.email,
    case when owner_match then 'approved' else 'pending' end,
    case when owner_match then 'admin' else 'member' end,
    case when owner_match then now() else null end
  )
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists mistwalk_on_auth_user_created on auth.users;
create trigger mistwalk_on_auth_user_created
  after insert on auth.users
  for each row execute function public.mistwalk_handle_new_user();

/* ------------------------------------------------------------------------- */
/* Existing-account backfill                                                 */
/* ------------------------------------------------------------------------- */

create or replace function public.mistwalk_sync_owner_emails()
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.mistwalk_members as m (user_id, email, status, role, decided_at)
  select u.id, u.email, 'approved', 'admin', now()
    from auth.users u
    join public.mistwalk_owner_emails o
      on lower(o.email) = lower(u.email)
  on conflict (user_id) do update
     set status = 'approved',
         role = 'admin',
         decided_at = now(),
         email = coalesce(excluded.email, m.email);
$$;

revoke all on function public.mistwalk_sync_owner_emails() from public, anon, authenticated;

-- No-op until the allowlist has entries. Safe to re-run.
select public.mistwalk_sync_owner_emails();
