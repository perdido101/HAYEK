import { handleProxy } from "../_lib/proxy";
import { buildDeps } from "../_lib/deps";

// Edge runtime (per spec). The handler uses only Web APIs — fetch,
// ReadableStream.tee, crypto.subtle — and captures via next/after, verified
// end-to-end (non-stream + streamed reassembly) against the local stack.
export const runtime = "edge";
export const dynamic = "force-dynamic";

/** Anthropic Messages passthrough. Point the Anthropic SDK's baseURL here. */
export async function POST(req: Request): Promise<Response> {
  return handleProxy(req, "anthropic", buildDeps());
}
