# HAYEK

The trust boundary for your intelligence exhaust. Capture the prompts, traces,
and corrections you'd otherwise leak to a model vendor — inside your own tenant —
and compound them into assets you own: private evals, a model-agnostic router,
and fine-tune-ready datasets.

```
CAPTURE → EVALS → ROUTER → DISTILL → AUDIT
```

## Status

**Phase 2 — EVAL VAULT.** Corrections become evals; evals run against a per-org
model registry; the **comparison table** (rows = evals, columns = models) is the
buy screen. A failing cell walks back the provenance chain
`run_result → eval → correction → trace` — "this model fails because a reviewer
corrected it, and here's what they wrote." The eval runner lives in
`core/evals` (pure, injected judge). Built on Phase 1 CAPTURE (the drop-in
proxy, SDK endpoints, correction inbox) and Phase 0's validated schema + RLS.

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
src/core/            pure domain logic (trace schema, cost provenance, SSE framing)
src/adapters/        the ONLY place a provider's wire details live (anthropic, openai)
src/app/api/v1/      the capture proxy + SDK endpoints (edge)
src/app/(app)/       dashboard, traces, inbox, settings (auth-gated)
src/lib/supabase/    client (anon, RLS), server (SSR, RLS)
src/server/admin.ts  service-role client — QUARANTINED to the proxy
packages/sdk/        @hayek/sdk — wrapTrace(), logCorrection()
supabase/migrations/ schema + RLS  (0001_init, 0002_capture)
supabase/tests/      rls_boundary.sql — adversarial cross-org/immutability proof
scripts/             mock-upstream + seed-demo (local loop demo)
tests/               guard tests (core purity, admin quarantine)
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

## The capture proxy

`/v1/messages` (Anthropic) and `/v1/chat/completions` (OpenAI + any
OpenAI-compatible upstream) are drop-in: point your SDK's base URL at
`…/v1` and use a HAYEK key. The proxy (edge runtime) forwards the call,
returns the provider response **byte-identical**, and captures a Trace.

- **Streaming is tee'd** — the client gets tokens with zero added latency; we
  reassemble the full output only after the stream closes (`src/app/api/v1/_lib/proxy.ts`).
- **Capture never breaks the call** — every persist path is wrapped and
  swallowed; a DB outage still returns the provider's bytes and status.
- **Errors are captured too** — a 429 or content-filter refusal lands as a
  Trace with its status and body.
- **Org resolves only from `sha256(key)`** → a non-revoked `api_keys` row.
  Provider specifics live only in `/src/adapters`.

**Known cost of the Edge choice:** if a client disconnects mid-stream, the
background drain (`next/after`) can be cut short and that one trace is not
captured — the client's call is never affected. We don't guess at how often:
the proxy counts `stream_started` vs `stream_drained` per org in `capture_stats`,
so the loss rate is an honest number, not a shrug.

## Develop

```bash
npm install
npm test             # 35 tests incl. the two guards + proxy integration
npm run typecheck
npm run build

# local stack (Supabase CLI is a dev dependency)
npx supabase start   # Postgres + Auth
npx supabase db reset               # applies supabase/migrations/*
psql "$DB_URL" -f supabase/tests/rls_boundary.sql   # 12 RLS assertions
```

Copy `.env.example` → `.env.local` and fill in the Supabase keys. The
service-role key is used **only** by the quarantined proxy (`src/server/admin.ts`);
never expose it to the browser.

## Demo path (Phase 1) — the whole loop in one curl

Two helper processes back the demo without a paid provider:

```bash
node scripts/mock-upstream.mjs   # a mock LLM (OpenAI + Anthropic, streaming)
node scripts/seed-demo.mjs       # demo org + login + API key + upstream
npm run dev
```

`seed-demo` prints a login (`demo@hayek.test` / `hayekdemo123`) and an API key.
Point the proxy at the mock and watch a trace appear:

```bash
# a real completion comes back, byte-identical...
curl -N http://localhost:3000/api/v1/chat/completions \
  -H "authorization: Bearer hyk_live_demokey_0000000000000000" \
  -H "content-type: application/json" \
  -d '{"model":"mock-gpt","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

Then open the app: **TRACES** shows the captured call, **INBOX** puts the model
output beside an editable pane — edit, ⌘↵ to save, and the dashboard's
"Knowledge retained" counter ticks up. That correction is the gold.
