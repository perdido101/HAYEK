import { createAdminClient, orgFromRequest, asUuidOrNull } from "../../../_lib/sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /v1/traces/:id/correction — the gold. What @hayek/sdk's logCorrection()
 * posts. The trace must belong to the key's org (no cross-org corrections).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const org = await orgFromRequest(req);
  if (!org) return json(401, { error: "invalid or revoked API key" });

  const { id: traceId } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error: "invalid JSON body" });
  }

  const correctedOutput = body.corrected_output;
  if (typeof correctedOutput !== "string" || correctedOutput.length === 0) {
    return json(400, { error: "corrected_output is required" });
  }
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return json(400, { error: "rating must be an integer 1-5" });
  }

  const admin = createAdminClient();

  // The trace must exist AND belong to this key's org.
  const { data: trace } = await admin
    .from("traces")
    .select("id, org_id")
    .eq("id", traceId)
    .maybeSingle();
  if (!trace || trace.org_id !== org.orgId) {
    return json(404, { error: "trace not found" });
  }

  const { data, error } = await admin
    .from("corrections")
    .insert({
      trace_id: traceId,
      org_id: org.orgId,
      corrected_output: correctedOutput,
      rating,
      reason: typeof body.reason === "string" ? body.reason : null,
      author: asUuidOrNull(body.author),
      status: "pending",
    })
    .select("id")
    .single();

  if (error) return json(500, { error: "failed to persist correction" });
  return json(200, { id: data.id });
}

function json(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
