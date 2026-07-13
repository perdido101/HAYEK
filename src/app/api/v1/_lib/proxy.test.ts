import { describe, it, expect, vi } from "vitest";
import { handleProxy, type ProxyDeps, type PersistTraceInput } from "./proxy";

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeDeps(fetchImpl: typeof fetch, persistImpl?: (t: PersistTraceInput) => Promise<void>) {
  const persisted: PersistTraceInput[] = [];
  const scheduled: Promise<void>[] = [];
  const deps: ProxyDeps = {
    fetchImpl,
    resolveKey: async (key: string) =>
      key === "hyk_good"
        ? { orgId: "org-1", apiKeyId: "key-1", upstream: { baseUrl: "https://upstream.test", apiKey: "sk-real" } }
        : null,
    persistTrace: async (t) => {
      if (persistImpl) return persistImpl(t);
      persisted.push(t);
    },
    schedule: (work) => {
      scheduled.push(work()); // start immediately, like the real drain does
    },
  };
  return { deps, persisted, settle: () => Promise.all(scheduled) };
}

function req(protocol: "anthropic" | "openai", body: unknown): Request {
  return new Request("https://acme.hayek.app/v1/x", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer hyk_good" },
    body: JSON.stringify(body),
  });
}

function sse(chunks: string[], status = 200, contentType = "text/event-stream"): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": contentType } });
}

describe("capture proxy", () => {
  it("401s when the key does not resolve — before any upstream call", async () => {
    const fetchImpl = vi.fn();
    const { deps } = makeDeps(fetchImpl as unknown as typeof fetch);
    const bad = new Request("https://x/v1/x", {
      method: "POST",
      headers: { authorization: "Bearer nope" },
      body: "{}",
    });
    const res = await handleProxy(bad, "openai", deps);
    expect(res.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("streams tee'd, byte-identical, and captures the reassembled output", async () => {
    const chunks = [
      'data: {"model":"gpt-4o","choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"model":"gpt-4o","choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ];
    const fetchImpl = vi.fn(async () => sse(chunks));
    const { deps, persisted, settle } = makeDeps(fetchImpl as unknown as typeof fetch);

    const res = await handleProxy(req("openai", { model: "gpt-4o", stream: true }), "openai", deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const clientText = dec.decode(await new Response(res.body).arrayBuffer());
    expect(clientText).toBe(chunks.join("")); // byte-identical passthrough

    await settle();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.output).toBe("Hello");
    expect(persisted[0]!.tokensOut).toBe(2);
    expect(persisted[0]!.statusCode).toBe(200);

    // upstream got the swapped auth, not the client's hayek key
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect((init.headers as Headers).get("authorization")).toBe("Bearer sk-real");
  });

  it("delivers the first chunk before the upstream finishes (no full-buffering)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated = new ReadableStream<Uint8Array>({
      pull: (() => {
        let stage = 0;
        return async (controller: ReadableStreamDefaultController<Uint8Array>) => {
          if (stage === 0) {
            controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
            stage = 1;
          } else if (stage === 1) {
            await gate; // withhold the rest until the test releases it
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
            stage = 2;
          }
        };
      })(),
    });
    const fetchImpl = vi.fn(
      async () => new Response(gated, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const { deps, settle } = makeDeps(fetchImpl as unknown as typeof fetch);

    const res = await handleProxy(req("openai", { stream: true }), "openai", deps);
    const reader = res.body!.getReader();
    const first = await reader.read(); // must resolve while gate is still closed
    expect(dec.decode(first.value)).toContain("first");

    release(); // now let the upstream finish
    // drain the rest
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    await settle();
  });

  it("captures error responses (429) with status + body, byte-identical", async () => {
    const errBody = '{"error":{"type":"rate_limit","message":"slow down"}}';
    const fetchImpl = vi.fn(
      async () => new Response(errBody, { status: 429, headers: { "content-type": "application/json" } }),
    );
    const { deps, persisted, settle } = makeDeps(fetchImpl as unknown as typeof fetch);

    const res = await handleProxy(req("anthropic", { model: "claude-sonnet-5" }), "anthropic", deps);
    expect(res.status).toBe(429);
    expect(await res.text()).toBe(errBody);

    await settle();
    expect(persisted[0]!.statusCode).toBe(429);
    expect(persisted[0]!.output).toBe(errBody);
  });

  it("never breaks the call when capture throws", async () => {
    const body = JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} });
    const fetchImpl = vi.fn(
      async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const { deps, settle } = makeDeps(fetchImpl as unknown as typeof fetch, async () => {
      throw new Error("DB down");
    });

    const res = await handleProxy(req("openai", {}), "openai", deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body); // caller unharmed
    await expect(settle()).resolves.not.toThrow();
  });

  it("returns 502 and captures when the upstream is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const { deps, persisted, settle } = makeDeps(fetchImpl as unknown as typeof fetch);
    const res = await handleProxy(req("openai", {}), "openai", deps);
    expect(res.status).toBe(502);
    await settle();
    expect(persisted[0]!.statusCode).toBe(502);
  });
});
