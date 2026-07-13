import { anthropicAdapter } from "./anthropic";
import { openaiAdapter } from "./openai";
import type { ProviderAdapter } from "./types";

export * from "./types";
export { anthropicAdapter } from "./anthropic";
export { openaiAdapter } from "./openai";

/** Wire protocol keyed by the proxy endpoint that received the call. */
export const ADAPTERS: Record<string, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
};

export function getAdapter(protocol: "anthropic" | "openai"): ProviderAdapter {
  return ADAPTERS[protocol]!;
}
