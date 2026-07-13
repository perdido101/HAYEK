-- ============================================================================
-- HAYEK — 0005_models (Phase 2b, MODEL REGISTRY)
-- "Which models can this org run against?" — the columns of the comparison
-- table, and the foundation of Phase 3's Choice test. An org registers
-- providers (its own API keys / arbitrary OpenAI-compatible endpoints) and the
-- specific models to test. NOT a hardcoded list.
--
-- Provider secrets are ENCRYPTED at rest (AES-256-GCM, app-managed key) — the
-- column holds ciphertext, and is additionally hidden from `authenticated` via
-- column grants + a key-less view. Only the server-side run executor decrypts.
-- (upstreams from 0002 keeps its plaintext key for now; encrypting it is a
-- follow-up that would touch the working proxy, deliberately not done here.)
-- ============================================================================

create table model_providers (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs (id) on delete cascade,
  label             text not null,
  adapter           provider_kind not null,   -- anthropic | openai | openai_compatible
  base_url          text,                      -- null => adapter default; required for openai_compatible
  api_key_encrypted text not null,             -- AES-256-GCM ciphertext (base64)
  created_at        timestamptz not null default now()
);

create index model_providers_org_idx on model_providers (org_id);

create table models (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs (id) on delete cascade,
  provider_id uuid not null references model_providers (id) on delete cascade,
  model_id    text not null,           -- wire name, e.g. 'gpt-4o', 'mock-gpt'
  label       text,                    -- display; defaults to model_id
  created_at  timestamptz not null default now(),
  unique (org_id, provider_id, model_id)
);

create index models_org_idx on models (org_id);
create index models_provider_idx on models (provider_id);

-- ---- RLS -------------------------------------------------------------------
alter table model_providers enable row level security;
alter table model_providers force row level security;
create policy "model_providers: member read"   on model_providers for select using (is_org_member(org_id));
create policy "model_providers: member write"  on model_providers for insert with check (is_org_member(org_id));
create policy "model_providers: member update" on model_providers for update using (is_org_member(org_id)) with check (is_org_member(org_id));
create policy "model_providers: member delete" on model_providers for delete using (is_org_member(org_id));

alter table models enable row level security;
alter table models force row level security;
create policy "models: member read"   on models for select using (is_org_member(org_id));
create policy "models: member write"  on models for insert with check (is_org_member(org_id));
create policy "models: member update" on models for update using (is_org_member(org_id)) with check (is_org_member(org_id));
create policy "models: member delete" on models for delete using (is_org_member(org_id));

-- ---- GRANTS ----------------------------------------------------------------
-- authenticated may INSERT/UPDATE the ciphertext (write-only) but never SELECT
-- it: SELECT is column-scoped to everything except api_key_encrypted.
grant select (id, org_id, label, adapter, base_url, created_at) on model_providers to authenticated;
grant insert on model_providers to authenticated;
grant update (label, base_url, api_key_encrypted) on model_providers to authenticated;
grant delete on model_providers to authenticated;

grant select, insert, update, delete on models to authenticated;

grant select, insert, update, delete on model_providers, models to service_role;

-- key-less view for the UI
create view model_providers_public
  with (security_invoker = on) as
  select id, org_id, label, adapter, base_url, created_at
  from model_providers;

grant select on model_providers_public to authenticated, service_role;
