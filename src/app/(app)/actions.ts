"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { generateApiKey } from "@/server/apikey";

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
}): Promise<{ ok: true } | { error: string }> {
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

  const { error } = await supabase.from("corrections").insert({
    trace_id: input.traceId,
    org_id: trace.org_id,
    corrected_output: input.correctedOutput,
    rating: input.rating ?? 5,
    reason: input.reason || null,
    author: user.id,
    status: "accepted",
  });
  if (error) return { error: error.message };

  revalidatePath("/inbox");
  revalidatePath("/");
  return { ok: true };
}
