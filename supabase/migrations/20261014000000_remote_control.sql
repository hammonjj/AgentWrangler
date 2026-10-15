-- Remote control (#112, #172): docs/plans/remote-control-supabase.md §2.
--
-- Supabase holds as little as possible: who may use the project (profiles), when the Mac was
-- last seen (daemons), and who may join which Realtime topic. No transcripts, device keys or
-- commands are stored; everything the Mac and a device say to each other is end-to-end
-- encrypted Broadcast traffic.
--
-- Every row is keyed on auth.uid() and cascades from auth.users, never on a GitHub id, so a
-- second sign-in provider or deleting the account needs no schema change.

-- ---- profiles: the gate every policy checks ----

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- 'none' until set by hand. Only 'owner' may do anything (see is_owner()).
  role text not null default 'none' check (role in ('none', 'owner')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- A user may read their own profile (the loader shows "not enabled for this account").
-- There is no insert, update or delete policy: nobody can grant themselves a role.
create policy "profiles: read own" on public.profiles
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Every new user gets a 'none' profile. Owners are made by hand in the SQL editor:
--   update public.profiles set role = 'owner' where user_id = '<uuid>';
create function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Whether the calling user is an owner. Security definer so policies on other tables can ask
-- without exposing profiles; stable so Postgres evaluates it once per statement.
create function public.is_owner() returns boolean
  language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where user_id = (select auth.uid()) and role = 'owner'
  );
$$;

revoke execute on function public.is_owner() from public;
grant execute on function public.is_owner() to authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ---- daemons: the Mac's heartbeat ----

create table public.daemons (
  -- Chosen by the daemon and kept on the Mac, so a restart updates the same row.
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- The daemon's build, so the loader can say which one it is talking to while offline.
  build text not null default '' check (length(build) <= 64),
  last_seen_at timestamptz not null default now()
);

create index daemons_user_id on public.daemons (user_id);

alter table public.daemons enable row level security;

create policy "daemons: owner reads own" on public.daemons
  for select to authenticated
  using (user_id = (select auth.uid()) and (select public.is_owner()));

create policy "daemons: owner inserts own" on public.daemons
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_owner()));

create policy "daemons: owner updates own" on public.daemons
  for update to authenticated
  using (user_id = (select auth.uid()) and (select public.is_owner()))
  with check (user_id = (select auth.uid()) and (select public.is_owner()));

create policy "daemons: owner deletes own" on public.daemons
  for delete to authenticated
  using (user_id = (select auth.uid()) and (select public.is_owner()));

-- ---- Realtime: private topics aw:<uid>:... ----
--
-- Topics are 'aw:<uid>:lobby' and 'aw:<uid>:c:<random>' (plan §2.2). An owner may receive
-- (select) and send (insert) Broadcast and Presence on their own topics and no others.

create policy "realtime: owner receives own topics" on realtime.messages
  for select to authenticated
  using (
    starts_with((select realtime.topic()), 'aw:' || (select auth.uid())::text || ':')
    and realtime.messages.extension in ('broadcast', 'presence')
    and (select public.is_owner())
  );

create policy "realtime: owner sends on own topics" on realtime.messages
  for insert to authenticated
  with check (
    starts_with((select realtime.topic()), 'aw:' || (select auth.uid())::text || ':')
    and realtime.messages.extension in ('broadcast', 'presence')
    and (select public.is_owner())
  );
