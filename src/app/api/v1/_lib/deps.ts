import { after } from "next/server";
import { createAdminClient } from "@/server/admin";
import { sha256Hex } from "@/server/apikey";
import { getAdapter } from "@/adapters";
import { priceTrace, resolveModel, type RoutePolicy, type RunEvidence } from "@/core";
import type { ProxyDeps, ResolvedKey, PersistTraceInput, RouteOutcome } from "./proxy";

/**
 * Real wiring for the capture proxy. This is the ONLY place the service-role
 * client is used (quarantine guard enforces it lives under /v1). org_id is
 * resolved solely by hashing the presented key.
 */

const ANTHROPIC_PROVIDERS = ["anthropic"];
const OPENAI_PROVIDERS = ["openai", "openai_compatible"];

export async function resolveOrgId(presentedKey: string): Promise<{ orgId: string; apiKeyId: string } | null> {
  const admin = createAdminClient();
  const hash = await sha256Hex(presentedKey);
  const { data } = await admin
    .from("api_keys")
    .select("id, org_id")
    .eq("key_hash", hash)
    .is("revoked_at", null)
    .maybeSingle();
  if (!data) return null;
  return { orgId: data.org_id as string, apiKeyId: data.id as string };
}

async function resolveKey(
  presentedKey: string,
  protocol: "anthropic" | "openai",
): Promise<ResolvedKey | null> {
  const found = await resolveOrgId(presentedKey);
  if (!found) return null;

  const admin = createAdminClient();
  const providers = protocol === "anthropic" ? ANTHROPIC_PROVIDERS : OPENAI_PROVIDERS;
  const { data: rows } = await admin
    .from("upstreams")
    .select("base_url, api_key, provider, is_default, created_at")
    .eq("org_id", found.orgId)
    .in("provider", providers)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1);

  const row = rows?.[0];
  const upstream = row
    ? { baseUrl: (row.base_url as string | null) ?? getAdapter(protocol).defaultBaseUrl, apiKey: row.api_key as string }
    : null;

  return { orgId: found.orgId, apiKeyId: found.apiKeyId, upstream };
}

async function persistTrace(t: PersistTraceInput): Promise<void> {
  const admin = createAdminClient();
  const pricing = priceTrace(t.model, t.tokensIn, t.tokensOut);
  const { error } = await admin.from("traces").insert({
    org_id: t.orgId,
    model: t.model,
    prompt_messages: t.promptMessages,
    output: t.output,
    status_code: t.statusCode,
    latency_ms: t.latencyMs,
    tokens_in: t.tokensIn,
    tokens_out: t.tokensOut,
    cost_estimate: pricing.cost_estimate,
    rate_in: pricing.rate_in,
    rate_out: pricing.rate_out,
    price_table_version: pricing.price_table_version,
    routed_from: t.routing?.routedFrom ?? null,
    routed_to: t.routing?.routedTo ?? null,
    policy_id: t.routing?.policyId ?? null,
    resolution_reason: t.routing?.resolutionReason ?? null,
    unrouted_reason: t.routing?.unroutedReason ?? null,
  });
  if (error) throw error; // captureSafely swallows; surfaces in logs only
}

function median(xs: number[]): number | null {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : Math.round((v[mid - 1]! + v[mid]!) / 2);
}

/**
 * Resolve a task name to a routed model via the pure resolveModel over live run
 * evidence. null => the task name is unknown to this org.
 */
async function resolveRoute(orgId: string, taskName: string): Promise<RouteOutcome | null> {
  const admin = createAdminClient();

  const { data: task } = await admin
    .from("tasks")
    .select("id")
    .eq("org_id", orgId)
    .eq("name", taskName)
    .maybeSingle();
  if (!task) return null;

  const { data: policyRow } = await admin
    .from("route_policies")
    .select("id, candidates, strategy, pinned_model, min_pass_rate, freshness_days")
    .eq("org_id", orgId)
    .eq("task_id", task.id)
    .maybeSingle();
  if (!policyRow) return { policyId: null, model: null, reason: "no policy for task" };

  const { data: suite } = await admin
    .from("suites")
    .select("id")
    .eq("org_id", orgId)
    .eq("task_id", task.id)
    .maybeSingle();
  if (!suite) return { policyId: policyRow.id as string, model: null, reason: "no suite bound to task" };

  const { data: runRows } = await admin
    .from("runs")
    .select("id, model, pass_rate, cost, finished_at")
    .eq("suite_id", suite.id)
    .order("started_at", { ascending: false });
  const runIds = (runRows ?? []).map((r) => r.id as string);
  const { data: rr } = runIds.length
    ? await admin.from("run_results").select("run_id, latency_ms").in("run_id", runIds)
    : { data: [] };
  const latByRun = new Map<string, number[]>();
  for (const r of rr ?? []) {
    const arr = latByRun.get(r.run_id as string) ?? [];
    if (r.latency_ms != null) arr.push(r.latency_ms as number);
    latByRun.set(r.run_id as string, arr);
  }

  const evidence: RunEvidence[] = (runRows ?? []).map((r) => ({
    model: r.model as string,
    passRate: (r.pass_rate as number) ?? 0,
    cost: (r.cost as number) ?? 0,
    medianLatencyMs: median(latByRun.get(r.id as string) ?? []),
    finishedAt: (r.finished_at as string) ?? new Date(0).toISOString(),
  }));

  const policy: RoutePolicy = {
    candidates: (policyRow.candidates ?? []) as RoutePolicy["candidates"],
    strategy: policyRow.strategy as RoutePolicy["strategy"],
    pinnedModel: (policyRow.pinned_model as string | null) ?? null,
    minPassRate: (policyRow.min_pass_rate as number) ?? 1,
    freshnessDays: (policyRow.freshness_days as number) ?? 30,
  };

  const resolution = resolveModel(policy, evidence, Date.now());
  return { policyId: policyRow.id as string, model: resolution.model, reason: resolution.reason };
}

async function touchKey(apiKeyId: string): Promise<void> {
  const admin = createAdminClient();
  await admin.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", apiKeyId);
}

async function bumpStat(orgId: string, field: "stream_started" | "stream_drained"): Promise<void> {
  const admin = createAdminClient();
  await admin.rpc("bump_capture_stat", { p_org: orgId, p_field: field });
}

export function buildDeps(): ProxyDeps {
  return {
    fetchImpl: fetch,
    resolveKey,
    persistTrace,
    touchKey,
    bumpStat,
    resolveRoute,
    schedule: (work) => after(work),
  };
}
