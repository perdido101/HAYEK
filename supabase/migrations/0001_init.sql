-- ============================================================================
-- HAYEK — 0001_init
-- Foundation: tenancy (orgs + members) and Module 1 CAPTURE (tasks, traces,
-- corrections). RLS is the trust boundary. Every domain table is org-scoped
-- and NO cross-org read is possible. Later phases add their own migrations
-- (evals/suites/runs in 0002, route policies in 0003, ...).
-- ============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
create type org_role as enum ('owner', 'admin', 'member');

-- ----------------------------------------------------------------------------
-- profiles — 1:1 mirror of auth.users, so we can show authors without
-- exposing the auth schema. Populated by a trigger on signup.
-- ----------------------------------------------------------------------------
create table profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  display_name text,
  created_at  timestamptz not null default now()
);

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', new.email));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ----------------------------------------------------------------------------
-- orgs + org_members — the tenant. A user sees data only for orgs they belong
-- to. This is enforced by is_org_member() below, referenced by every policy.
-- ----------------------------------------------------------------------------
create table orgs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table org_members (
  org_id     uuid not null references orgs (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       org_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index org_members_user_idx on org_members (user_id);

-- SECURITY DEFINER membership check. Bypasses RLS on org_members (avoids
-- infinite policy recursion) and is the single source of truth for "can this
-- user touch this org's rows?". STABLE so the planner can cache per-statement.
create or replace function is_org_member(target_org uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.org_members m
    where m.org_id = target_org
      and m.user_id = auth.uid()
  );
$$;

-- Atomic "create org + become owner". Runs as definer so the fresh org and
-- the caller's membership are inserted together before any RLS check applies.
create or replace function create_org(org_name text)
returns orgs
language plpgsql
security definer
set search_path = public
as $$
declare
  new_org orgs;
begin
  if auth.uid() is null then
    raise exception 'must be authenticated';
  end if;

  insert into public.orgs (name) values (org_name) returning * into new_org;
  insert into public.org_members (org_id, user_id, role)
    values (new_org.id, auth.uid(), 'owner');

  return new_org;
end;
$$;

-- ----------------------------------------------------------------------------
-- tasks — a named job the router will bind to an EvalSuite (Module 3).
-- Introduced here because traces reference a task.
-- ----------------------------------------------------------------------------
create table tasks (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs (id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

create index tasks_org_idx on tasks (org_id);

-- ----------------------------------------------------------------------------
-- traces — MODULE 1. One row per proxied model call. Written by the capture
-- proxy (service role); read by org members via RLS.
-- ----------------------------------------------------------------------------
create table traces (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs (id) on delete cascade,
  task_id         uuid references tasks (id) on delete set null,
  model           text not null,
  prompt_messages jsonb not null,
  output          text,
  latency_ms      integer,
  tokens_in       integer,
  tokens_out      integer,
  cost_estimate   numeric(12, 6),
  created_at      timestamptz not null default now()
);

create index traces_org_created_idx on traces (org_id, created_at desc);
create index traces_task_idx on traces (task_id);

-- ----------------------------------------------------------------------------
-- corrections — MODULE 1's gold. A human's edit of a trace's output.
-- ----------------------------------------------------------------------------
create table corrections (
  trace_id         uuid primary key references traces (id) on delete cascade,
  org_id           uuid not null references orgs (id) on delete cascade,
  corrected_output text not null,
  rating           smallint not null check (rating between 1 and 5),
  reason           text,
  author           uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now()
);

create index corrections_org_created_idx on corrections (org_id, created_at desc);

-- ============================================================================
-- ROW LEVEL SECURITY
-- Default-deny: enable RLS, then grant exactly membership-scoped access.
-- FORCE so even the table owner is subject to policies.
-- ============================================================================

-- profiles: a user reads/updates only their own row.
alter table profiles enable row level security;
alter table profiles force row level security;

create policy "profiles: self read"   on profiles for select using (id = auth.uid());
create policy "profiles: self update" on profiles for update using (id = auth.uid()) with check (id = auth.uid());

-- orgs: visible only to members. Creation goes through create_org() (definer),
-- so there is no direct INSERT policy — you cannot conjure an org you don't own.
alter table orgs enable row level security;
alter table orgs force row level security;

create policy "orgs: member read"   on orgs for select using (is_org_member(id));
create policy "orgs: admin update"  on orgs for update using (is_org_member(id)) with check (is_org_member(id));

-- org_members: members can see the roster of their own orgs.
alter table org_members enable row level security;
alter table org_members force row level security;

create policy "org_members: member read" on org_members for select using (is_org_member(org_id));

-- tasks: full CRUD scoped to membership.
alter table tasks enable row level security;
alter table tasks force row level security;

create policy "tasks: member read"   on tasks for select using (is_org_member(org_id));
create policy "tasks: member write"  on tasks for insert with check (is_org_member(org_id));
create policy "tasks: member update" on tasks for update using (is_org_member(org_id)) with check (is_org_member(org_id));
create policy "tasks: member delete" on tasks for delete using (is_org_member(org_id));

-- traces: members read; members may insert/update within their org (the proxy
-- uses the service role and bypasses RLS entirely, so these policies govern
-- only in-app access).
alter table traces enable row level security;
alter table traces force row level security;

create policy "traces: member read"   on traces for select using (is_org_member(org_id));
create policy "traces: member write"  on traces for insert with check (is_org_member(org_id));
create policy "traces: member update" on traces for update using (is_org_member(org_id)) with check (is_org_member(org_id));
create policy "traces: member delete" on traces for delete using (is_org_member(org_id));

-- corrections: members read/write within their org.
alter table corrections enable row level security;
alter table corrections force row level security;

create policy "corrections: member read"   on corrections for select using (is_org_member(org_id));
create policy "corrections: member write"  on corrections for insert with check (is_org_member(org_id));
create policy "corrections: member update" on corrections for update using (is_org_member(org_id)) with check (is_org_member(org_id));
create policy "corrections: member delete" on corrections for delete using (is_org_member(org_id));
