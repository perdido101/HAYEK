import { priceTrace } from "@/core";
import { createAdminClient, orgFromRequest, asUuidOrNull } from "../_lib/sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SDK direct trace log — what @hayek/sdk's wrapTrace() posts. Org is resolved
 * only from the hashed key. Returns { id } so the caller can attach corrections.
 */
export async function POST(req: Request): Promise<Response> {
  const org = await orgFromRequest(req);
  if (!org) return json(401, { error: "invalid or revoked API key" });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error: "invalid JSON body" });
  }

  const model = String(body.model ?? "unknown");
  const tokensIn = numOrNull(body.tokens_in);
  const tokensOut = numOrNull(body.tokens_out);
  const pricing = priceTrace(model, tokensIn, tokensOut);

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("traces")
    .insert({
      org_id: org.orgId,
      task_id: asUuidOrNull(body.task_id),
      model,
      prompt_messages: body.prompt_messages ?? [],
      output: body.output == null ? null : String(body.output),
      status_code: numOrNull(body.status_code) ?? 200,
      latency_ms: numOrNull(body.latency_ms),
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_estimate: pricing.cost_estimate,
      rate_in: pricing.rate_in,
      rate_out: pricing.rate_out,
      price_table_version: pricing.price_table_version,
    })
    .select("id")
    .single();

  if (error) return json(500, { error: "failed to persist trace" });
  return json(200, { id: data.id });
}

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function json(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
