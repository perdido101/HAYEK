import { parseSSE, tryParseJSON } from "@/core";
import type { Extracted, ProviderAdapter, RequestFacts } from "./types";

/**
 * OpenAI Chat Completions API (also the wire protocol for OpenAI-compatible
 * upstreams: Ollama, vLLM, Groq). Streaming shape:
 *   each data chunk -> choices[0].delta.content ; final "[DONE]" sentinel
 *   usage present only when stream_options.include_usage is set (last chunk)
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

export const openaiAdapter: ProviderAdapter = {
  id: "openai",
  defaultBaseUrl: "https://api.openai.com",
  upstreamPath: "/v1/chat/completions",
  stripRequestHeaders: ["authorization", "x-api-key"],

  authHeader(upstreamKey) {
    return { name: "authorization", value: `Bearer ${upstreamKey}` };
  },

  buildRequest(model, messages) {
    return {
      path: "/v1/chat/completions",
      body: { model, stream: false, messages },
    };
  },

  readRequest(body): RequestFacts {
    const json = tryParseJSON<{
      model?: string;
      stream?: boolean;
      messages?: { role?: string; content?: unknown }[];
    }>(body);
    if (!json) return { model: null, messages: [], stream: false };
    const messages = (json.messages ?? []).map((m) => ({
      role: String(m.role ?? "user"),
      content: contentToString(m.content),
    }));
    return { model: json.model ?? null, messages, stream: Boolean(json.stream) };
  },

  extractFromStream(sseText): Extracted {
    let output = "";
    let tokensIn: number | null = null;
    let tokensOut: number | null = null;
    let model: string | null = null;

    for (const ev of parseSSE(sseText)) {
      if (ev.data.trim() === "[DONE]") continue;
      const d = tryParseJSON<Record<string, any>>(ev.data);
      if (!d) continue;
      model = d.model ?? model;
      const choice = Array.isArray(d.choices) ? d.choices[0] : undefined;
      if (choice?.delta?.content) output += choice.delta.content;
      if (d.usage) {
        tokensIn = d.usage.prompt_tokens ?? tokensIn;
        tokensOut = d.usage.completion_tokens ?? tokensOut;
      }
    }
    return { output, tokensIn, tokensOut, model };
  },

  extractFromJson(body): Extracted {
    const d = tryParseJSON<Record<string, any>>(body);
    if (!d) return { output: "", tokensIn: null, tokensOut: null, model: null };
    const choice = Array.isArray(d.choices) ? d.choices[0] : undefined;
    return {
      output: contentToString(choice?.message?.content),
      tokensIn: d.usage?.prompt_tokens ?? null,
      tokensOut: d.usage?.completion_tokens ?? null,
      model: d.model ?? null,
    };
  },
};
