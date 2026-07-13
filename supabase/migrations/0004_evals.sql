-- ============================================================================
-- HAYEK — 0004_evals (Phase 2, EVAL VAULT)
-- Corrections become evals; evals get run against models; runs are evidence.
-- The provenance chain correction -> eval -> run must never break — Distill and
-- Audit both depend on it, so source_correction_id is preserved (set null on
-- correction delete, not cascade).
--
-- Immutability: runs and run_results are append-only for app users (SELECT
-- only). They are evidence, written by the server-side run executor
-- (service role). rls_boundary.sql proves this.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- suites — a named collection of evals, optionally bound to a task (Module 3).
-- ----------------------------------------------------------------------------
create table suites (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs (id) on delete cascade,
  name       text not null,
  task_id    uuid references tasks (id) on delete set null,
  created_at timestamptz not null default now()
);

create index suites_org_idx on suites (org_id);

-- ----------------------------------------------------------------------------
-- evals — one test. input_messages is the prompt; expected_behavior a prose
-- rubric; assertions[] the machine checks. source_correction_id is the
-- provenance link back to the gold that produced it.
-- ----------------------------------------------------------------------------
create table evals (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references orgs (id) on delete cascade,
  suite_id             uuid not null references suites (id) on delete cascade,
  name                 text not null,
  input_messages       jsonb not null,
  expected_behavior    text,
  assertions           jsonb not null default '[]'::jsonb,
  tags                 text[] not null default '{}',
  source_correction_id uuid references corrections (id) on delete set null,
  created_at           timestamptz not null default now()
);

create index evals_suite_idx on evals (suite_id);
create index evals_org_idx on evals (org_id);

-- ----------------------------------------------------------------------------
-- runs — one execution of a suite against one model. Evidence: append-only.
-- ----------------------------------------------------------------------------
create table runs (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references orgs (id) on delete cascade,
  suite_id            uuid not null references suites (id) on delete cascade,
  model               text not null,
  adapter             text not null,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  pass_rate           numeric(5, 4),
  cost                numeric(12, 6),
  price_table_version text
);

create index runs_suite_started_idx on runs (suite_id, started_at desc);
create index runs_org_idx on runs (org_id);

-- ----------------------------------------------------------------------------
-- run_results — per-eval outcome within a run. org_id carried for direct RLS.
-- ----------------------------------------------------------------------------
create table run_results (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null references runs (id) on delete cascade,
  org_id            uuid not null references orgs (id) on delete cascade,
  eval_id           uuid not null references evals (id) on delete cascade,
  passed            boolean not null,
  score             numeric(5, 4),
  output            text,
  assertion_results jsonb not null default '[]'::jsonb,
  latency_ms        integer,
  error             text
);

create index run_results_run_idx on run_results (run_id);
create index run_results_eval_idx on run_results (eval_id);

-- ============================================================================
-- RLS — suites/evals are member-CRUD; runs/run_results are SELECT-only for
-- app users (evidence). service_role (the executor) writes runs.
-- ============================================================================

alter table suites enable row level security;
alter table suites force row level security;
create policy "suites: member read"   on suites for select using (is_org_member(org_id));
create policy "suites: member write"  on suites for insert with check (is_org_member(org_id));
create policy "suites: member update" on suites for update using (is_org_member(org_id)) with check (is_org_member(org_id));
create policy "suites: member delete" on suites for delete using (is_org_member(org_id));

alter table evals enable row level security;
alter table evals force row level security;
create policy "evals: member read"   on evals for select using (is_org_member(org_id));
create policy "evals: member write"  on evals for insert with check (is_org_member(org_id));
create policy "evals: member update" on evals for update using (is_org_member(org_id)) with check (is_org_member(org_id));
create policy "evals: member delete" on evals for delete using (is_org_member(org_id));

-- runs / run_results: read-only evidence for app users.
alter table runs enable row level security;
alter table runs force row level security;
create policy "runs: member read" on runs for select using (is_org_member(org_id));

alter table run_results enable row level security;
alter table run_results force row level security;
create policy "run_results: member read" on run_results for select using (is_org_member(org_id));

-- ============================================================================
-- GRANTS — explicit, like 0001. RLS constrains rows; grants gate the verb.
-- ============================================================================
grant select, insert, update, delete on suites to authenticated;
grant select, insert, update, delete on evals  to authenticated;
grant select                         on runs        to authenticated;  -- evidence
grant select                         on run_results to authenticated;  -- evidence

grant select, insert, update, delete
  on suites, evals, runs, run_results
  to service_role;
