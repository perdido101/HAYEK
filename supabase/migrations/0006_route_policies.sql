-- ============================================================================
-- HAYEK — 0006_route_policies (Phase 3, ROUTER)
-- A policy binds a task to a set of candidate models and a strategy. The router
-- only routes to a model that has PASSED this task's suite recently enough —
-- no model routes on vibes. resolveModel() (pure, in core) is the arbiter.
-- Policies are config (member-CRUD), not evidence.
-- ============================================================================

create type route_strategy as enum ('cheapest_passing', 'fastest_passing', 'pinned');

create table route_policies (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs (id) on delete cascade,
  task_id       uuid not null references tasks (id) on delete cascade,
  candidates    jsonb not null default '[]'::jsonb,   -- ModelRef[]: [{ "model": "gpt-4o" }, ...]
  strategy      route_strategy not null default 'cheapest_passing',
  pinned_model  text,                                  -- required only when strategy = 'pinned'
  min_pass_rate numeric(5, 4) not null default 1.0,
  freshness_days integer not null default 30,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, task_id)   -- one active policy per task
);

create index route_policies_org_idx on route_policies (org_id);

alter table route_policies enable row level security;
alter table route_policies force row level security;
create policy "route_policies: member read"   on route_policies for select using (is_org_member(org_id));
create policy "route_policies: member write"  on route_policies for insert with check (is_org_member(org_id));
create policy "route_policies: member update" on route_policies for update using (is_org_member(org_id)) with check (is_org_member(org_id));
create policy "route_policies: member delete" on route_policies for delete using (is_org_member(org_id));

grant select, insert, update, delete on route_policies to authenticated;
grant select, insert, update, delete on route_policies to service_role;

-- ----------------------------------------------------------------------------
-- Routing provenance on the trace: what the router decided and why. Nullable —
-- an unrouted call (no task / no policy / nothing eligible) leaves these null
-- except unrouted_reason, which explains why routing did not apply.
-- ----------------------------------------------------------------------------
alter table traces add column routed_from       text;
alter table traces add column routed_to         text;
alter table traces add column policy_id          uuid references route_policies (id) on delete set null;
alter table traces add column resolution_reason text;
alter table traces add column unrouted_reason   text;
