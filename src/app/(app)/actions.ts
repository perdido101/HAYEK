"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { generateApiKey } from "@/server/apikey";
import { encryptSecret } from "@/server/crypto";

async function currentOrg(): Promise<{ userId: string; orgId: string } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: m } = await supabase
    .from("org_members")
    .select("org_id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!m) return null;
  return { userId: user.id, orgId: m.org_id as string };
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

/**
 * Create an API key. Authenticated path — RLS ("api_keys: member write") lets a
 * member insert into their own org. We generate the key, store ONLY its hash,
 * and return the plaintext once. No service-role client involved.
 */
export async function createApiKey(name: string): Promise<{ key: string } | { error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { data: membership } = await supabase
    .from("org_members")
    .select("org_id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!membership) return { error: "no org" };

  const { key, keyHash, prefix } = await generateApiKey();
  const { error } = await supabase.from("api_keys").insert({
    org_id: membership.org_id,
    key_hash: keyHash,
    prefix,
    name: name || "default",
  });
  if (error) return { error: error.message };

  revalidatePath("/settings");
  return { key };
}

export async function revokeApiKey(id: string): Promise<void> {
  const supabase = await createClient();
  await supabase.from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", id);
  revalidatePath("/settings");
}

/**
 * Save a correction — the gold. Insert path only (corrections are many-per-trace).
 * RLS forces author = auth.uid(), so we set it from the session. Saving IS
 * accepting: the human affirmed this output, so status = 'accepted'. Rating is
 * optional in the UI; omitted defaults to 5 (the reviewer just made it correct).
 */
export async function saveCorrection(input: {
  traceId: string;
  correctedOutput: string;
  rating?: number | null;
  reason?: string | null;
}): Promise<{ ok: true; id: string } | { error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };
  if (!input.correctedOutput.trim()) return { error: "correction is empty" };

  const { data: trace } = await supabase
    .from("traces")
    .select("org_id")
    .eq("id", input.traceId)
    .maybeSingle();
  if (!trace) return { error: "trace not found" };

  const { data: made, error } = await supabase
    .from("corrections")
    .insert({
      trace_id: input.traceId,
      org_id: trace.org_id,
      corrected_output: input.correctedOutput,
      rating: input.rating ?? 5,
      reason: input.reason || null,
      author: user.id,
      status: "accepted",
    })
    .select("id")
    .single();
  if (error) return { error: error.message };

  revalidatePath("/inbox");
  revalidatePath("/");
  return { ok: true, id: made.id as string };
}

// ---- model registry --------------------------------------------------------
export async function addModelProvider(input: {
  label: string;
  adapter: "anthropic" | "openai" | "openai_compatible";
  baseUrl: string;
  apiKey: string;
}): Promise<{ ok: true } | { error: string }> {
  const org = await currentOrg();
  if (!org) return { error: "not authenticated" };
  if (!input.label.trim() || !input.apiKey.trim()) return { error: "label and key required" };

  const supabase = await createClient();
  // Secret encrypted at rest (AES-256-GCM) before it ever hits the DB.
  const api_key_encrypted = await encryptSecret(input.apiKey);
  const { error } = await supabase.from("model_providers").insert({
    org_id: org.orgId,
    label: input.label,
    adapter: input.adapter,
    base_url: input.baseUrl.trim() || null,
    api_key_encrypted,
  });
  if (error) return { error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}

export async function addModel(input: {
  providerId: string;
  modelId: string;
  label?: string;
}): Promise<{ ok: true } | { error: string }> {
  const org = await currentOrg();
  if (!org) return { error: "not authenticated" };
  if (!input.modelId.trim()) return { error: "model id required" };

  const supabase = await createClient();
  const { error } = await supabase.from("models").insert({
    org_id: org.orgId,
    provider_id: input.providerId,
    model_id: input.modelId.trim(),
    label: input.label?.trim() || input.modelId.trim(),
  });
  if (error) return { error: error.message };
  revalidatePath("/settings");
  revalidatePath("/evals");
  return { ok: true };
}

// ---- suites + promote-to-eval ---------------------------------------------
export async function createSuite(name: string): Promise<{ id: string } | { error: string }> {
  const org = await currentOrg();
  if (!org) return { error: "not authenticated" };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("suites")
    .insert({ org_id: org.orgId, name: name.trim() || "Untitled suite" })
    .select("id")
    .single();
  if (error) return { error: error.message };
  revalidatePath("/evals");
  return { id: data.id as string };
}

/**
 * Promote a correction to an eval — the conversion step of the whole product,
 * kept near-free. Prefills input_messages from the trace, expected_behavior
 * from the correction reason, and a `contains` assertion from the corrected
 * output. source_correction_id keeps the provenance chain intact.
 */
export async function promoteToEval(
  correctionId: string,
): Promise<{ suiteId: string; evalId: string } | { error: string }> {
  const org = await currentOrg();
  if (!org) return { error: "not authenticated" };
  const supabase = await createClient();

  const { data: correction } = await supabase
    .from("corrections")
    .select("id, trace_id, corrected_output, reason")
    .eq("id", correctionId)
    .maybeSingle();
  if (!correction) return { error: "correction not found" };

  const { data: trace } = await supabase
    .from("traces")
    .select("prompt_messages, model")
    .eq("id", correction.trace_id)
    .maybeSingle();

  // get-or-create the "Promotions" suite
  let suiteId: string;
  const { data: existing } = await supabase
    .from("suites")
    .select("id")
    .eq("org_id", org.orgId)
    .eq("name", "Promotions")
    .maybeSingle();
  if (existing) suiteId = existing.id as string;
  else {
    const { data: made, error } = await supabase
      .from("suites")
      .insert({ org_id: org.orgId, name: "Promotions" })
      .select("id")
      .single();
    if (error) return { error: error.message };
    suiteId = made.id as string;
  }

  const corrected = correction.corrected_output as string;
  // a short, salient snippet the model output must contain (human edits after)
  const snippet = corrected.trim().split("\n")[0]!.slice(0, 40);
  const messages = (trace?.prompt_messages ?? []) as { role: string; content: string }[];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const name = (lastUser?.content ?? "promoted eval").slice(0, 60);

  const { data: made, error } = await supabase
    .from("evals")
    .insert({
      org_id: org.orgId,
      suite_id: suiteId,
      name,
      input_messages: messages,
      expected_behavior: correction.reason ?? null,
      assertions: [{ type: "contains", value: snippet }],
      tags: ["promoted"],
      source_correction_id: correctionId,
    })
    .select("id")
    .single();
  if (error) return { error: error.message };

  revalidatePath("/evals");
  return { suiteId, evalId: made.id as string };
}
