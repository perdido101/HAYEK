# HAYEK

The trust boundary for your intelligence exhaust. Capture the prompts, traces,
and corrections you'd otherwise leak to a model vendor — inside your own tenant —
and compound them into assets you own: private evals, a model-agnostic router,
and fine-tune-ready datasets.

```
CAPTURE → EVALS → ROUTER → DISTILL → AUDIT
```

## Status

**Phase 0 — foundation.** Scaffold, Supabase schema + RLS, org model, the pure
`core/` domain, and the architecture guard test. UI comes in Phase 1.

## Stack

- Next.js 15 (App Router) · TypeScript strict · Tailwind
- Supabase (Postgres + Auth + **Row Level Security**) — RLS is the trust boundary
- Model adapters: Anthropic / OpenAI / any OpenAI-compatible base URL (`/src/adapters`)
- Vitest

## Architecture rules (sacred), enforced by guard tests

- **`/src/core/**` is pure.** The trace schema, eval runner, scoring, router
  policy — zero framework imports, zero network. Everything depends on `core`;
  `core` depends on nothing. `tests/core-purity.test.ts` fails the build if
  `core` imports `next`/`react`/`supabase` or touches the network.
- **The service-role client is quarantined.** `src/server/admin.ts` bypasses
  RLS, so it may be imported ONLY from the capture proxy under
  `src/app/api/v1/**`. `tests/admin-quarantine.test.ts` fails the build on any
  other importer.

## Layout

```
src/core/            pure domain logic (trace schema, cost provenance)
src/lib/supabase/    client (anon, RLS), server (SSR, RLS)
src/server/admin.ts  service-role client — QUARANTINED to the proxy
src/app/             Next.js App Router
packages/sdk/        @hayek/sdk — wrapTrace(), logCorrection()
supabase/migrations/ schema + RLS  (0001_init.sql)
tests/               guard tests
```

## The trust boundary (RLS)

Every domain table is org-scoped. A single `SECURITY DEFINER` function,
`is_org_member(org_id)` (empty `search_path`, fully qualified), backs every
policy, so **no cross-org read is possible**. Orgs are created via the
`create_org()` RPC (definer), which inserts the org and the caller's `owner`
membership atomically — you cannot conjure an org you don't belong to.

**The proxy is the sharp edge.** `service_role` carries `BYPASSRLS`; `FORCE RLS`
does not stop it. So the capture proxy resolves `org_id` **only** by hashing the
presented API key and matching a non-revoked `api_keys` row — never from a
header, body, or query the caller controls.

**Traces are immutable.** Evals, the Choice grid, and the distill export all
cite traces as evidence, so app users get a READ policy and nothing else — no
UPDATE, no DELETE. Deletion is a retention job (service role), not a user.
Corrections are many-per-trace with a `status` (`pending`/`accepted`/`rejected`)
so Phase 4 knows which one is the answer; each is editable only by its author.

See `supabase/migrations/0001_init.sql`.

## Develop

```bash
npm install
npm test            # 14 tests: core purity guard, cost/schema, sdk
npm run typecheck
npm run build

# database (requires the Supabase CLI)
supabase start
supabase db reset   # applies supabase/migrations/*
```

Copy `.env.example` → `.env.local` and fill in the Supabase keys. The
service-role key is used **only** by the capture proxy (Phase 1); never expose
it to the browser.

## Demo path (Phase 0)

1. `npm test` — 14 green, including the purity guard.
2. Add an import of `next`/`react`/`@supabase/*` anywhere under `src/core/` and
   re-run: the guard turns that file red. Remove it: green again.
3. `npm run build` — compiles; the placeholder landing renders the five-step loop.
4. Read `supabase/migrations/0001_init.sql` — the schema and every RLS policy.
