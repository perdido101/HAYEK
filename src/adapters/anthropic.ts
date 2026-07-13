import { parseSSE, tryParseJSON } from "@/core";
import type { Extracted, ProviderAdapter, RequestFacts } from "./types";

/**
 * Anthropic Messages API. Streaming shape:
 *   message_start        -> message.usage.input_tokens
 *   content_block_delta  -> delta.text (type "text_delta")
 *   message_delta        -> usage.output_tokens (cumulative)
 */
function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text ?? "") : "",
      )
      .join("");
  }
  return "";
}

export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  defaultBaseUrl: "https://api.anthropic.com",
  upstreamPath: "/v1/messages",
  stripRequestHeaders: ["x-api-key", "authorization"],

  authHeader(upstreamKey) {
    return { name: "x-api-key", value: upstreamKey };
  },

  readRequest(body): RequestFacts {
    const json = tryParseJSON<{
      model?: string;
      stream?: boolean;
      system?: unknown;
      messages?: { role?: string; content?: unknown }[];
    }>(body);
    if (!json) return { model: null, messages: [], stream: false };

    const messages: RequestFacts["messages"] = [];
    if (json.system) messages.push({ role: "system", content: contentToString(json.system) });
    for (const m of json.messages ?? []) {
      messages.push({ role: String(m.role ?? "user"), content: contentToString(m.content) });
    }
    return { model: json.model ?? null, messages, stream: Boolean(json.stream) };
  },

  extractFromStream(sseText): Extracted {
    let output = "";
    let tokensIn: number | null = null;
    let tokensOut: number | null = null;
    let model: string | null = null;

    for (const ev of parseSSE(sseText)) {
      const d = tryParseJSON<Record<string, any>>(ev.data);
      if (!d) continue;
      const type = d.type ?? ev.event;
      if (type === "message_start") {
        model = d.message?.model ?? model;
        tokensIn = d.message?.usage?.input_tokens ?? tokensIn;
        tokensOut = d.message?.usage?.output_tokens ?? tokensOut;
      } else if (type === "content_block_delta") {
        if (d.delta?.type === "text_delta") output += d.delta.text ?? "";
      } else if (type === "message_delta") {
        tokensOut = d.usage?.output_tokens ?? tokensOut;
      }
    }
    return { output, tokensIn, tokensOut, model };
  },

  extractFromJson(body): Extracted {
    const d = tryParseJSON<Record<string, any>>(body);
    if (!d) return { output: "", tokensIn: null, tokensOut: null, model: null };
    return {
      output: contentToString(d.content),
      tokensIn: d.usage?.input_tokens ?? null,
      tokensOut: d.usage?.output_tokens ?? null,
      model: d.model ?? null,
    };
  },
};
