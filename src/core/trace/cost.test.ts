import { describe, it, expect } from "vitest";
import { estimateCost, priceTrace, PRICE_TABLE_VERSION } from "./cost";
import { TraceSchema, CorrectionSchema } from "./schema";

describe("estimateCost", () => {
  it("prices a known model from the table", () => {
    // opus: $15/1M in, $75/1M out. 1000 in, 500 out.
    const cost = estimateCost("claude-opus-4-8", 1000, 500);
    expect(cost).toBeCloseTo(1000 / 1e6 * 15 + 500 / 1e6 * 75, 9);
  });

  it("returns 0 for an unknown model rather than throwing", () => {
    expect(estimateCost("some-local-llm", 9999, 9999)).toBe(0);
  });

  it("treats null token counts as zero", () => {
    expect(estimateCost("gpt-4o", null, null)).toBe(0);
  });
});

describe("priceTrace provenance", () => {
  it("returns the exact rates and table version used", () => {
    const p = priceTrace("claude-sonnet-5", 1000, 1000);
    expect(p.rate_in).toBe(3);
    expect(p.rate_out).toBe(15);
    expect(p.price_table_version).toBe(PRICE_TABLE_VERSION);
    expect(p.cost_estimate).toBeCloseTo(3 / 1e3 + 15 / 1e3, 9);
  });

  it("stamps the version but null rates for an unknown model", () => {
    const p = priceTrace("mystery-model", 100, 100);
    expect(p.cost_estimate).toBe(0);
    expect(p.rate_in).toBeNull();
    expect(p.rate_out).toBeNull();
    expect(p.price_table_version).toBe(PRICE_TABLE_VERSION);
  });
});

describe("domain schemas", () => {
  it("accepts a well-formed trace", () => {
    const parsed = TraceSchema.safeParse({
      id: "00000000-0000-0000-0000-000000000001",
      org_id: "00000000-0000-0000-0000-000000000002",
      task_id: null,
      model: "claude-sonnet-5",
      prompt_messages: [{ role: "user", content: "hi" }],
      output: "hello",
      status_code: 200,
      latency_ms: 120,
      tokens_in: 3,
      tokens_out: 2,
      cost_estimate: 0.0001,
      rate_in: 3,
      rate_out: 15,
      price_table_version: "2026-01",
      created_at: new Date(0).toISOString(),
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a correction with an out-of-range rating", () => {
    const parsed = CorrectionSchema.safeParse({
      id: "00000000-0000-0000-0000-000000000003",
      trace_id: "00000000-0000-0000-0000-000000000001",
      org_id: "00000000-0000-0000-0000-000000000002",
      corrected_output: "fixed",
      rating: 9,
      reason: null,
      author: null,
      status: "pending",
      created_at: new Date(0).toISOString(),
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a correction with an unknown status", () => {
    const parsed = CorrectionSchema.safeParse({
      id: "00000000-0000-0000-0000-000000000003",
      trace_id: "00000000-0000-0000-0000-000000000001",
      org_id: "00000000-0000-0000-0000-000000000002",
      corrected_output: "fixed",
      rating: 4,
      reason: null,
      author: null,
      status: "maybe",
      created_at: new Date(0).toISOString(),
    });
    expect(parsed.success).toBe(false);
  });
});
