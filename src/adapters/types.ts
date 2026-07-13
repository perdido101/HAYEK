/**
 * Provider adapters. The ONLY place a provider's wire details are allowed to
 * live (auth header, default base URL, how to read output + usage off a
 * response). Nothing outside /src/adapters may hardcode a provider.
 *
 * Adapters are pure: they interpret bytes, they do not perform I/O.
 */

/** What the proxy needs to extract from a completed response for the Trace. */
export interface Extracted {
  output: string;
  tokensIn: number | null;
  tokensOut: number | null;
  model: string | null;
}

/** What the proxy needs to read off the incoming request body for the Trace. */
export interface RequestFacts {
  model: string | null;
  messages: { role: string; content: string }[];
  stream: boolean;
}

export interface ProviderAdapter {
  /** Stable id: matches upstreams.provider wire protocol. */
  id: "anthropic" | "openai";
  /** Default upstream if the org's upstream row omits a base_url. */
  defaultBaseUrl: string;
  /** Upstream path this adapter's endpoint maps to (appended to base_url). */
  upstreamPath: string;
  /** Header carrying the upstream credential (swapped in by the proxy). */
  authHeader(upstreamKey: string): { name: string; value: string };
  /** Header names to strip from the client request before forwarding. */
  stripRequestHeaders: string[];
  /** Read model/messages/stream off the raw request body (best-effort). */
  readRequest(body: string): RequestFacts;
  /** Reassemble output + usage from a full SSE stream payload. */
  extractFromStream(sseText: string): Extracted;
  /** Read output + usage from a non-streamed JSON response body. */
  extractFromJson(body: string): Extracted;
}
