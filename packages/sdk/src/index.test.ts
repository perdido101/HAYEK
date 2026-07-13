import { describe, it, expect, vi } from "vitest";
import { createHayekClient } from "./index";

describe("HayekClient.wrapTrace", () => {
  it("returns the provider result unchanged and posts a trace", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "trace-123" }), { status: 200 }),
    );
    const client = createHayekClient({
      baseUrl: "https://acme.hayek.app/",
      apiKey: "sk-test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const providerResult = { text: "hello world", usage: { in: 5, out: 2 } };
    const { result, traceId } = await client.wrapTrace({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      call: async () => providerResult,
      extract: (r) => ({ output: r.text, tokensIn: r.usage.in, tokensOut: r.usage.out }),
    });

    expect(result).toBe(providerResult);
    expect(traceId).toBe("trace-123");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://acme.hayek.app/v1/traces");
    expect(JSON.parse(init.body as string).output).toBe("hello world");
  });

  it("never loses the result when capture fails", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    const client = createHayekClient({
      baseUrl: "https://acme.hayek.app",
      apiKey: "sk-test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const { result, traceId } = await client.wrapTrace({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      call: async () => ({ text: "still here" }),
      extract: (r) => ({ output: r.text }),
    });

    expect(result).toEqual({ text: "still here" });
    expect(traceId).toBe("");
  });
});
