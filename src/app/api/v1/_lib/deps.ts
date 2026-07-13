import { after } from "next/server";
import { createAdminClient } from "@/server/admin";
import { sha256Hex } from "@/server/apikey";
import { getAdapter } from "@/adapters";
import { priceTrace } from "@/core";
import type { ProxyDeps, ResolvedKey, PersistTraceInput } from "./proxy";

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
  });
  if (error) throw error; // captureSafely swallows; surfaces in logs only
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
    schedule: (work) => after(work),
  };
}
