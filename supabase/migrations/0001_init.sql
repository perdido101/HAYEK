-- ============================================================================
-- HAYEK — 0001_init
-- Foundation. RLS is the trust boundary: every domain table is org-scoped and
-- NO cross-org read is possible. Cross-cutting concerns live HERE regardless of
-- which phase first uses them — tenancy, api_keys, trace immutability, and the
-- task FK — because deferring them means a data backfill, not a create table.
-- Later, per-phase migrations add evals/suites/runs (0002), route policies, etc.
--
-- Two things this file takes seriously:
--   1. The capture proxy uses the service_role key, which carries BYPASSRLS.
--      FORCE RLS does not stop it. So the proxy must resolve org_id ONLY from a
--      hashed api_key (below), never from caller-controlled input. That is the
--      real boundary once the proxy runs.
--   2. Traces are the ledger. Evals, the Choice grid, and the distill export
--      all cite them as evidence, so they are IMMUTABLE to app users: no UPDATE
--      or DELETE policy exists. Deletion is a retention job (service role), not
--      a user action.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
create type org_role as enum ('owner', 'admin', 'member');
create type correction_status as enum ('pending', 'accepted', 'rejected');

-- ----------------------------------------------------------------------------
-- profiles — 1:1 mirror of auth.users so we can show authors without exposing
-- the auth schema. Populated by a trigger on signup.
-- ----------------------------------------------------------------------------
create table profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text,
  display_name text,
  created_at   timestamptz not null default now()
);

-- SECURITY DEFINER + empty search_path (prevents search_path hijack; all refs
-- are schema-qualified). Flagged by Supabase's own linter otherwise.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
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
-- orgs + org_members — the tenant. is_org_member() below is the single source
-- of truth for "can this user touch this org's rows?" and backs every policy.
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

-- Bypasses RLS on org_members (avoids policy recursion) and is STABLE so the
-- planner caches it per-statement. Empty search_path; fully qualified refs.
create or replace function is_org_member(target_org uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.org_members m
    where m.org_id = target_org
      and m.user_id = auth.uid()
  );
$$;

-- Atomic "create org + become owner". Definer so the fresh org and the caller's
-- membership are inserted together before any RLS check applies.
create or replace function create_org(org_name text)
returns public.orgs
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_org public.orgs;
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
-- api_keys — the proxy's ONLY way to resolve an org. The plaintext key is shown
-- to the customer once; we store sha256(key). The proxy hashes the presented
-- key and looks up a non-revoked row. org_id comes from THIS row and nothing
-- the caller can set. `prefix` (first chars) is for display/lookup only.
-- ----------------------------------------------------------------------------
create table api_keys (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs (id) on delete cascade,
  key_hash     text not null unique,       -- hex sha256 of the plaintext key
  prefix       text not null,              -- e.g. "hyk_live_a1b2" for display
  name         text not null,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index api_keys_org_idx on api_keys (org_id);

-- ----------------------------------------------------------------------------
-- tasks — a named job the router binds to an EvalSuite (Module 3). Here because
-- traces reference it (deferring the FK would mean a backfill).
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
-- traces — MODULE 1, the immutable ledger. Written by the proxy (service role);
-- read by org members. Cost provenance (rate_in/out + price_table_version) is
-- stored on the row so repricing the table never rewrites history.
-- ----------------------------------------------------------------------------
create table traces (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references orgs (id) on delete cascade,
  task_id             uuid references tasks (id) on delete set null,
  model               text not null,
  prompt_messages     jsonb not null,
  output              text,             -- response body (success OR error body)
  status_code         integer,         -- upstream HTTP status; a 429/refusal is signal too
  latency_ms          integer,
  tokens_in           integer,
  tokens_out          integer,
  cost_estimate       numeric(12, 6),
  rate_in             numeric(12, 6),   -- USD / 1M input tokens applied
  rate_out            numeric(12, 6),   -- USD / 1M output tokens applied
  price_table_version text,             -- which table produced the rates above
  created_at          timestamptz not null default now()
);

create index traces_org_created_idx on traces (org_id, created_at desc);
create index traces_org_task_idx on traces (org_id, task_id);

-- ----------------------------------------------------------------------------
-- corrections — MODULE 1's gold. MANY per trace: reviewers disagree, and Phase
-- 4 needs to know which one is the answer. `status` resolves that — only
-- `accepted` corrections are eligible for distillation.
-- ----------------------------------------------------------------------------
create table corrections (
  id               uuid primary key default gen_random_uuid(),
  trace_id         uuid not null references traces (id) on delete cascade,
  org_id           uuid not null references orgs (id) on delete cascade,
  corrected_output text not null,
  rating           smallint not null check (rating between 1 and 5),
  reason           text,
  author           uuid references auth.users (id) on delete set null,
  status           correction_status not null default 'pending',
  created_at       timestamptz not null default now()
);

create index corrections_org_created_idx on corrections (org_id, created_at desc);
create index corrections_trace_idx on corrections (trace_id);

-- ============================================================================
-- ROW LEVEL SECURITY — default-deny. Enable + FORCE (owner is subject too),
-- then grant exactly membership-scoped access. Remember: service_role BYPASSES
-- all of this; these policies govern the authenticated in-app path only.
-- ============================================================================

-- profiles: self only.
alter table profiles enable row level security;
alter table profiles force row level security;
create policy "profiles: self read"   on profiles for select using (id = auth.uid());
create policy "profiles: self update" on profiles for update using (id = auth.uid()) with check (id = auth.uid());

-- orgs: visible to members. Creation is create_org() (definer) only — no direct
-- INSERT policy, so you cannot conjure an org you don't belong to.
alter table orgs enable row level security;
alter table orgs force row level security;
create policy "orgs: member read"  on orgs for select using (is_org_member(id));
create policy "orgs: admin update" on orgs for update using (is_org_member(id)) with check (is_org_member(id));

-- org_members: members see their own orgs' roster.
alter table org_members enable row level security;
alter table org_members force row level security;
create policy "org_members: member read" on org_members for select using (is_org_member(org_id));

-- api_keys: members manage their org's keys. Revocation is an UPDATE
-- (revoked_at); we never hard-delete a key. The plaintext is never stored.
alter table api_keys enable row level security;
alter table api_keys force row level security;
create policy "api_keys: member read"   on api_keys for select using (is_org_member(org_id));
create policy "api_keys: member write"  on api_keys for insert with check (is_org_member(org_id));
create policy "api_keys: member revoke" on api_keys for update using (is_org_member(org_id)) with check (is_org_member(org_id));

-- tasks: full CRUD scoped to membership.
alter table tasks enable row level security;
alter table tasks force row level security;
create policy "tasks: member read"   on tasks for select using (is_org_member(org_id));
create policy "tasks: member write"  on tasks for insert with check (is_org_member(org_id));
create policy "tasks: member update" on tasks for update using (is_org_member(org_id)) with check (is_org_member(org_id));
create policy "tasks: member delete" on tasks for delete using (is_org_member(org_id));

-- traces: IMMUTABLE ledger. Members READ only. No insert (proxy uses service
-- role), no update, no delete — provenance is not theatre.
alter table traces enable row level security;
alter table traces force row level security;
create policy "traces: member read" on traces for select using (is_org_member(org_id));

-- corrections: any member may add one (author is forced to themselves, so
-- provenance is honest). A correction may be edited or removed ONLY by its
-- author. Status transitions are updates, also author-gated at this layer.
alter table corrections enable row level security;
alter table corrections force row level security;
create policy "corrections: member read"  on corrections for select using (is_org_member(org_id));
create policy "corrections: member write" on corrections for insert
  with check (is_org_member(org_id) and author = auth.uid());
create policy "corrections: author update" on corrections for update
  using (author = auth.uid()) with check (author = auth.uid());
create policy "corrections: author delete" on corrections for delete
  using (author = auth.uid());

-- ============================================================================
-- GRANTS — RLS filters rows, but a role still needs the table privilege first.
-- These are explicit (not left to platform default privileges) so the boundary
-- is reproducible across environments, not "works on my project".
--
--   authenticated : DML matching each table's policy surface (RLS constrains).
--   service_role  : full DML (it BYPASSES RLS; this is the trusted proxy path).
--   anon          : nothing — no anonymous access to tenant data.
-- ============================================================================
grant usage on schema public to authenticated, service_role;

-- authenticated — scoped to what the policies above allow.
grant select, update                 on profiles     to authenticated;
grant select, update                 on orgs         to authenticated;
grant select                         on org_members  to authenticated;
grant select, insert, update         on api_keys     to authenticated;
grant select, insert, update, delete on tasks        to authenticated;
grant select                         on traces       to authenticated;  -- immutable ledger
grant select, insert, update, delete on corrections  to authenticated;

-- service_role — the proxy and background jobs. RLS does not apply to it.
grant select, insert, update, delete
  on profiles, orgs, org_members, api_keys, tasks, traces, corrections
  to service_role;

grant execute on function is_org_member(uuid) to authenticated, service_role;
grant execute on function create_org(text)    to authenticated, service_role;
