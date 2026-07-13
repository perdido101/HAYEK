import { handleProxy } from "../_lib/proxy";
import { buildDeps } from "../_lib/deps";

// Node runtime for Phase 1 (reliable streaming + supabase-js). The handler uses
// only Web APIs (fetch, ReadableStream.tee, crypto), so flipping to Edge — the
// target per the spec — is a one-line change once validated there.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Anthropic Messages passthrough. Point the Anthropic SDK's baseURL here. */
export async function POST(req: Request): Promise<Response> {
  return handleProxy(req, "anthropic", buildDeps());
}
