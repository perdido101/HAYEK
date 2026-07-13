-- ============================================================================
-- HAYEK — 0002_capture (Phase 1)
-- Where the proxy forwards. An org registers one or more upstreams; each holds
-- the real provider credential. That secret is the one thing we must not leak
-- to the browser, so it is protected two ways:
--   - service_role gets full access (the proxy reads it server-side);
--   - authenticated gets COLUMN-level select on everything EXCEPT api_key, plus
--     a key-less view (upstreams_public) for the UI.
-- ============================================================================

create type provider_kind as enum ('anthropic', 'openai', 'openai_compatible');

create table upstreams (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs (id) on delete cascade,
  provider   provider_kind not null,
  base_url   text,                    -- null => the adapter's default base URL
  api_key    text not null,           -- upstream provider secret (never to browser)
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create index upstreams_org_idx on upstreams (org_id);
-- at most one default per (org, provider)
create unique index upstreams_one_default on upstreams (org_id, provider) where is_default;

alter table upstreams enable row level security;
alter table upstreams force row level security;

-- Members may read their org's upstream rows (column grants below hide api_key);
-- writing an upstream (which sets the secret) is a service-role/server action.
create policy "upstreams: member read" on upstreams for select using (is_org_member(org_id));

-- COLUMN-level grant: authenticated can select every column but api_key. A query
-- that touches api_key as an authenticated user errors at the privilege layer.
grant select (id, org_id, provider, base_url, is_default, created_at)
  on upstreams to authenticated;

grant select, insert, update, delete on upstreams to service_role;

-- Key-less view for the UI. security_invoker so the reader's RLS + column grants
-- apply (no privilege escalation through the view).
create view upstreams_public
  with (security_invoker = on) as
  select id, org_id, provider, base_url, is_default, created_at
  from upstreams;

grant select on upstreams_public to authenticated, service_role;
