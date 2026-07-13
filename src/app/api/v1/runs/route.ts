import { createClient } from "@/lib/supabase/server";
import { executeRun } from "../_lib/run";

// Node runtime: the executor decrypts secrets and fans out live model calls.
// Session-authenticated (cookies), unlike the api-key proxy routes.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json(401, { error: "not authenticated" });

  const { data: membership } = await supabase
    .from("org_members")
    .select("org_id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!membership) return json(403, { error: "no org" });

  let body: { suite_id?: string; model_ids?: string[]; judge_model_id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  if (!body.suite_id || !Array.isArray(body.model_ids) || body.model_ids.length === 0) {
    return json(400, { error: "suite_id and model_ids[] required" });
  }

  const result = await executeRun({
    orgId: membership.org_id as string,
    suiteId: body.suite_id,
    modelIds: body.model_ids,
    judgeModelId: body.judge_model_id ?? null,
  });

  if ("error" in result) return json(400, result);
  return json(200, result);
}

function json(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
