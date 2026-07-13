import { handleProxy } from "../../_lib/proxy";
import { buildDeps } from "../../_lib/deps";

export const runtime = "edge";
export const dynamic = "force-dynamic";

/** OpenAI Chat Completions passthrough (also OpenAI-compatible upstreams). */
export async function POST(req: Request): Promise<Response> {
  return handleProxy(req, "openai", buildDeps());
}
