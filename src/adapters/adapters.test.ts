import { describe, it, expect } from "vitest";
import { parseSSE } from "@/core";
import { anthropicAdapter } from "./anthropic";
import { openaiAdapter } from "./openai";

describe("parseSSE framing", () => {
  it("splits events and joins multi-line data", () => {
    const text = ": ping\n\nevent: foo\ndata: {\"a\":1}\n\ndata: line1\ndata: line2\n\n";
    const events = parseSSE(text);
    expect(events).toEqual([
      { event: "foo", data: '{"a":1}' },
      { event: undefined, data: "line1\nline2" },
    ]);
  });
});

describe("anthropic adapter", () => {
  const stream = [
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":12,"output_tokens":1}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":", world"}}',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}',
    "event: message_stop\ndata: {\"type\":\"message_stop\"}",
  ].join("\n\n");

  it("reassembles streamed output and usage", () => {
    const e = anthropicAdapter.extractFromStream(stream);
    expect(e.output).toBe("Hello, world");
    expect(e.tokensIn).toBe(12);
    expect(e.tokensOut).toBe(5);
    expect(e.model).toBe("claude-sonnet-5");
  });

  it("reads a non-streamed response", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-5",
      content: [{ type: "text", text: "Answer" }],
      usage: { input_tokens: 7, output_tokens: 3 },
    });
    const e = anthropicAdapter.extractFromJson(body);
    expect(e.output).toBe("Answer");
    expect(e.tokensIn).toBe(7);
    expect(e.tokensOut).toBe(3);
  });

  it("reads model + messages (incl. system) off the request", () => {
    const req = anthropicAdapter.readRequest(
      JSON.stringify({ model: "claude-opus-4-8", stream: true, system: "be terse", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(req.model).toBe("claude-opus-4-8");
    expect(req.stream).toBe(true);
    expect(req.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
  });
});

describe("openai adapter", () => {
  const stream = [
    'data: {"model":"gpt-4o","choices":[{"delta":{"content":"Hel"}}]}',
    'data: {"model":"gpt-4o","choices":[{"delta":{"content":"lo"}}]}',
    'data: {"model":"gpt-4o","choices":[{"delta":{}}],"usage":{"prompt_tokens":9,"completion_tokens":2}}',
    "data: [DONE]",
  ].join("\n\n");

  it("reassembles streamed output and usage, ignoring [DONE]", () => {
    const e = openaiAdapter.extractFromStream(stream);
    expect(e.output).toBe("Hello");
    expect(e.tokensIn).toBe(9);
    expect(e.tokensOut).toBe(2);
    expect(e.model).toBe("gpt-4o");
  });

  it("reads a non-streamed response", () => {
    const body = JSON.stringify({
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "Answer" } }],
      usage: { prompt_tokens: 4, completion_tokens: 1 },
    });
    const e = openaiAdapter.extractFromJson(body);
    expect(e.output).toBe("Answer");
    expect(e.tokensIn).toBe(4);
    expect(e.tokensOut).toBe(1);
  });

  it("never throws on malformed frames", () => {
    const e = openaiAdapter.extractFromStream("data: {not json\n\ndata: [DONE]");
    expect(e.output).toBe("");
  });
});
