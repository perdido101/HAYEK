import { getAdapter, type ProviderAdapter } from "@/adapters";

/**
 * The capture proxy — the business. It forwards a model call to the org's
 * upstream and returns the provider's response BYTE-IDENTICAL, while capturing
 * a Trace on our side. Three rules it must never break:
 *
 *   1. STREAMING: tee the SSE stream. The client gets tokens with zero added
 *      latency; we reassemble the full output only after the stream closes.
 *      We never buffer the whole response before returning it.
 *   2. CAPTURE NEVER BREAKS THE CALL: every persist path is wrapped and
 *      swallowed. DB down, malformed body, drain error — the caller still gets
 *      their provider response with the provider's own status.
 *   3. ERRORS ARE SIGNAL: a 429 or a content-filter refusal is captured too,
 *      with its status and body.
 *
 * This module is pure orchestration over injected deps, so it is testable with
 * a mock upstream and no DB. Routes under /v1 wire the real deps.
 */

export interface ResolvedKey {
  orgId: string;
  apiKeyId: string;
  /** null => key is valid but the org has no upstream for this protocol (502). */
  upstream: { baseUrl: string; apiKey: string } | null;
}

export interface PersistTraceInput {
  orgId: string;
  model: string;
  promptMessages: { role: string; content: string }[];
  output: string;
  statusCode: number;
  latencyMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  routing?: RoutingInfo;
}

/** What the router decided for this call (all null when routing didn't apply). */
export interface RoutingInfo {
  routedFrom: string | null;
  routedTo: string | null;
  policyId: string | null;
  resolutionReason: string | null;
  unroutedReason: string | null;
}

/** Outcome of resolving a task's policy. null => the task name is unknown. */
export interface RouteOutcome {
  policyId: string | null;
  model: string | null; // null => nothing qualified (or no policy/suite)
  reason: string;
}

export interface ProxyDeps {
  fetchImpl: typeof fetch;
  /** Hash the presented key and resolve org + the upstream for this protocol. null => 401. */
  resolveKey: (presentedKey: string, protocol: "anthropic" | "openai") => Promise<ResolvedKey | null>;
  /** Persist a trace. Must be called only via captureSafely (never awaited on the hot path). */
  persistTrace: (t: PersistTraceInput) => Promise<void>;
  /** Schedule work to run after the response is sent (Next's after()). */
  schedule: (work: () => Promise<void>) => void;
  /** Mark a key used. Best-effort. */
  touchKey?: (apiKeyId: string) => Promise<void>;
  /** Count streaming captures started vs drained (disconnect-loss signal). */
  bumpStat?: (orgId: string, field: "stream_started" | "stream_drained") => Promise<void>;
  /** Resolve a task name to a routed model. null => unknown task. */
  resolveRoute?: (orgId: string, taskName: string) => Promise<RouteOutcome | null>;
}

// Headers we must not copy back verbatim: fetch has already decoded the body,
// so content-encoding/length would lie; the rest are hop-by-hop.
const HOP_BY_HOP = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

function passthroughHeaders(from: Headers): Headers {
  const h = new Headers();
  from.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) h.set(key, value);
  });
  return h;
}

function extractPresentedKey(req: Request, protocol: "anthropic" | "openai"): string | null {
  if (protocol === "anthropic") {
    const k = req.headers.get("x-api-key");
    if (k) return k;
  }
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  // Anthropic may also send the key via authorization; openai only here.
  return req.headers.get("x-api-key");
}

async function drainToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/** Rewrite the `model` field in a JSON request body. null if not rewritable. */
function rewriteBodyModel(body: string, model: string): string | null {
  try {
    const obj = JSON.parse(body) as Record<string, unknown>;
    obj.model = model;
    return JSON.stringify(obj);
  } catch {
    return null;
  }
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { type: "hayek_error", message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleProxy(
  req: Request,
  protocol: "anthropic" | "openai",
  deps: ProxyDeps,
): Promise<Response> {
  const adapter: ProviderAdapter = getAdapter(protocol);

  // --- auth: org is resolved ONLY from the hashed presented key ---
  const presented = extractPresentedKey(req, protocol);
  if (!presented) return jsonError(401, "missing API key");
  const resolved = await deps.resolveKey(presented, protocol);
  if (!resolved) return jsonError(401, "invalid or revoked API key");
  if (deps.touchKey) deps.schedule(() => deps.touchKey!(resolved.apiKeyId).catch(() => {}));
  if (!resolved.upstream) return jsonError(502, `no ${protocol} upstream configured for this org`);
  const upstreamCfg = resolved.upstream;

  // --- read the request body ONCE; forward it unchanged ---
  let body = await req.text();
  let facts = adapter.readRequest(body);

  // --- ROUTING: if the call carries a task, resolve its policy and route.
  // Routing NEVER fails the call — an unresolvable task passes through unchanged
  // and is flagged on the trace. ---
  const routing: RoutingInfo = {
    routedFrom: null,
    routedTo: null,
    policyId: null,
    resolutionReason: null,
    unroutedReason: null,
  };
  const taskName = req.headers.get("x-hayek-task");
  if (taskName && deps.resolveRoute) {
    try {
      const outcome = await deps.resolveRoute(resolved.orgId, taskName);
      if (!outcome) {
        routing.unroutedReason = `unknown task: ${taskName}`;
      } else if (outcome.model) {
        routing.policyId = outcome.policyId;
        if (outcome.model !== facts.model) {
          const rewritten = rewriteBodyModel(body, outcome.model);
          if (rewritten) {
            routing.routedFrom = facts.model;
            routing.routedTo = outcome.model;
            routing.resolutionReason = outcome.reason;
            body = rewritten;
            facts = { ...facts, model: outcome.model };
          } else {
            routing.unroutedReason = "could not rewrite model in request body";
          }
        } else {
          routing.routedTo = outcome.model;
          routing.resolutionReason = outcome.reason;
        }
      } else {
        // policy resolved to nothing — the org's exposure. Do NOT substitute.
        routing.policyId = outcome.policyId;
        routing.unroutedReason = outcome.reason;
      }
    } catch {
      routing.unroutedReason = "routing error"; // never fail the call over routing
    }
  }

  // --- build the upstream request: swap auth + host, keep the body verbatim ---
  const url = upstreamCfg.baseUrl.replace(/\/+$/, "") + adapter.upstreamPath;
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("content-length");
  for (const h of adapter.stripRequestHeaders) headers.delete(h);
  const auth = adapter.authHeader(upstreamCfg.apiKey);
  headers.set(auth.name, auth.value);

  const started = performance.now();
  let upstream: Response;
  try {
    upstream = await deps.fetchImpl(url, { method: req.method, headers, body });
  } catch {
    // upstream unreachable — the call fails regardless of us. Capture the fact.
    const latencyMs = Math.round(performance.now() - started);
    captureSafely(deps, resolved, facts, {
      output: "",
      statusCode: 502,
      latencyMs,
      tokensIn: null,
      tokensOut: null,
    }, routing);
    return jsonError(502, "upstream unreachable");
  }

  const latencyMs = Math.round(performance.now() - started);
  const status = upstream.status;
  const isError = status >= 400;
  const contentType = upstream.headers.get("content-type") ?? "";
  const isStream = contentType.includes("text/event-stream") && upstream.body != null && !isError;

  if (isStream && upstream.body) {
    // TEE: one branch to the client now, one to capture after close.
    const [clientStream, captureStream] = upstream.body.tee();
    // Count the attempt on its own callback so it's recorded even if the drain
    // below is cut short by a client disconnect — that gap is the whole point.
    if (deps.bumpStat) deps.schedule(() => deps.bumpStat!(resolved.orgId, "stream_started").catch(() => {}));
    deps.schedule(async () => {
      try {
        const text = await drainToText(captureStream);
        const ex = adapter.extractFromStream(text);
        captureSafely(deps, resolved, facts, {
          output: ex.output,
          statusCode: status,
          latencyMs,
          tokensIn: ex.tokensIn,
          tokensOut: ex.tokensOut,
          model: ex.model,
        }, routing);
        if (deps.bumpStat) await deps.bumpStat(resolved.orgId, "stream_drained").catch(() => {});
      } catch {
        // drain/parse failed (e.g. client disconnected) — capture must not
        // affect the client stream, and stream_drained stays un-incremented.
      }
    });
    return new Response(clientStream, { status, headers: passthroughHeaders(upstream.headers) });
  }

  // Non-streaming (or an error response): read once, return the SAME bytes.
  const text = await upstream.text();
  deps.schedule(async () => {
    const ex = isError
      ? { output: text, tokensIn: null, tokensOut: null, model: null }
      : adapter.extractFromJson(text);
    captureSafely(deps, resolved, facts, {
      output: ex.output,
      statusCode: status,
      latencyMs,
      tokensIn: ex.tokensIn,
      tokensOut: ex.tokensOut,
      model: ex.model,
    }, routing);
  });
  return new Response(text, { status, headers: passthroughHeaders(upstream.headers) });
}

/** Build the persist input and write it, swallowing every failure. */
function captureSafely(
  deps: ProxyDeps,
  resolved: ResolvedKey,
  facts: { model: string | null; messages: { role: string; content: string }[] },
  r: {
    output: string;
    statusCode: number;
    latencyMs: number;
    tokensIn: number | null;
    tokensOut: number | null;
    model?: string | null;
  },
  routing?: RoutingInfo,
): void {
  Promise.resolve()
    .then(() =>
      deps.persistTrace({
        orgId: resolved.orgId,
        model: facts.model ?? r.model ?? "unknown",
        promptMessages: facts.messages,
        output: r.output,
        statusCode: r.statusCode,
        latencyMs: r.latencyMs,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        routing,
      }),
    )
    .catch(() => {
      // capture never breaks the call.
    });
}
