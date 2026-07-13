import { describe, it, expect } from "vitest";
import { resolveModel, classifyRun } from "./resolve";
import type { RoutePolicy, RunEvidence } from "./types";

const NOW = Date.parse("2026-03-04T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function policy(over: Partial<RoutePolicy> = {}): RoutePolicy {
  return {
    candidates: [{ model: "gpt-4o" }, { model: "claude-sonnet-5" }],
    strategy: "cheapest_passing",
    pinnedModel: null,
    minPassRate: 0.8,
    freshnessDays: 30,
    ...over,
  };
}
const run = (model: string, over: Partial<RunEvidence> = {}): RunEvidence => ({
  model,
  passRate: 1,
  cost: 0.01,
  medianLatencyMs: 100,
  finishedAt: daysAgo(1),
  ...over,
});

describe("classifyRun (the Choice grid states)", () => {
  it("grey when never evaluated", () => {
    expect(classifyRun(null, 0.8, 30, NOW)).toBe("grey");
  });
  it("red when the latest run fails, regardless of freshness", () => {
    expect(classifyRun({ passRate: 0.3, finishedAt: daysAgo(1) }, 0.8, 30, NOW)).toBe("red");
    expect(classifyRun({ passRate: 0.3, finishedAt: daysAgo(99) }, 0.8, 30, NOW)).toBe("red");
  });
  it("green when passing + fresh, amber when passing + stale", () => {
    expect(classifyRun({ passRate: 1, finishedAt: daysAgo(5) }, 0.8, 30, NOW)).toBe("green");
    expect(classifyRun({ passRate: 1, finishedAt: daysAgo(40) }, 0.8, 30, NOW)).toBe("amber");
  });
});

describe("resolveModel — eligibility", () => {
  it("excludes a candidate with no run as never_evaluated", () => {
    const r = resolveModel(policy(), [run("gpt-4o")], NOW);
    expect(r.excluded.find((e) => e.model === "claude-sonnet-5")?.why).toBe("never_evaluated");
  });

  it("excludes a stale run", () => {
    const r = resolveModel(policy({ freshnessDays: 30 }), [run("gpt-4o", { finishedAt: daysAgo(40) }), run("claude-sonnet-5")], NOW);
    expect(r.excluded.find((e) => e.model === "gpt-4o")?.why).toBe("stale");
    expect(r.model).toBe("claude-sonnet-5");
  });

  it("excludes a below-threshold run", () => {
    const r = resolveModel(policy({ minPassRate: 0.8 }), [run("gpt-4o", { passRate: 0.5 }), run("claude-sonnet-5")], NOW);
    expect(r.excluded.find((e) => e.model === "gpt-4o")?.why).toBe("below_threshold");
    expect(r.model).toBe("claude-sonnet-5");
  });

  it("uses the LATEST run per model (a fresh pass overrides an old fail)", () => {
    const r = resolveModel(policy({ candidates: [{ model: "gpt-4o" }] }), [
      run("gpt-4o", { passRate: 0, finishedAt: daysAgo(20) }),
      run("gpt-4o", { passRate: 1, finishedAt: daysAgo(1) }),
    ], NOW);
    expect(r.model).toBe("gpt-4o");
  });
});

describe("resolveModel — strategy", () => {
  it("cheapest_passing picks the lowest cost among eligible", () => {
    const r = resolveModel(policy({ strategy: "cheapest_passing" }), [
      run("gpt-4o", { cost: 0.01 }),
      run("claude-sonnet-5", { cost: 0.004 }),
    ], NOW);
    expect(r.model).toBe("claude-sonnet-5");
    expect(r.reason).toMatch(/cheapest_passing/);
  });

  it("fastest_passing picks the lowest median latency", () => {
    const r = resolveModel(policy({ strategy: "fastest_passing" }), [
      run("gpt-4o", { medianLatencyMs: 300 }),
      run("claude-sonnet-5", { medianLatencyMs: 120 }),
    ], NOW);
    expect(r.model).toBe("claude-sonnet-5");
  });

  it("pinned picks the pinned model when eligible", () => {
    const r = resolveModel(policy({ strategy: "pinned", pinnedModel: "gpt-4o" }), [run("gpt-4o"), run("claude-sonnet-5", { cost: 0.001 })], NOW);
    expect(r.model).toBe("gpt-4o");
  });

  it("pinned returns null when the pinned model is not eligible — no fallback", () => {
    const r = resolveModel(policy({ strategy: "pinned", pinnedModel: "gpt-4o" }), [
      run("gpt-4o", { passRate: 0.1 }), // pinned but failing
      run("claude-sonnet-5"), // eligible, but NOT chosen
    ], NOW);
    expect(r.model).toBeNull();
    expect(r.reason).toMatch(/pinned model gpt-4o is not eligible/);
  });
});

describe("resolveModel — the refusal (the trust proposition)", () => {
  it("returns model=null and a reason when NOTHING qualifies", () => {
    const r = resolveModel(policy({ minPassRate: 0.9 }), [
      run("gpt-4o", { passRate: 0.4 }),
      // claude never evaluated
    ], NOW);
    expect(r.model).toBeNull();
    expect(r.reason).toMatch(/no model currently qualifies/);
    expect(r.reason).toMatch(/below threshold/);
    expect(r.reason).toMatch(/never evaluated/);
  });

  it("does NOT fall back to a non-candidate model that happens to pass", () => {
    const r = resolveModel(policy({ candidates: [{ model: "gpt-4o" }] }), [
      run("gpt-4o", { passRate: 0.1 }), // candidate, failing
      run("some-other-model", { passRate: 1 }), // passing but NOT a candidate
    ], NOW);
    expect(r.model).toBeNull();
  });

  it("reports every candidate with a per-model reason", () => {
    const r = resolveModel(
      policy({ candidates: [{ model: "a" }, { model: "b" }, { model: "c" }], minPassRate: 0.8, freshnessDays: 30 }),
      [run("a"), run("b", { passRate: 0.2 }), run("c", { finishedAt: daysAgo(99) })],
      NOW,
    );
    // a eligible; b below_threshold; c stale
    expect(r.model).toBe("a");
    expect(r.excluded.find((e) => e.model === "b")?.why).toBe("below_threshold");
    expect(r.excluded.find((e) => e.model === "c")?.why).toBe("stale");
    expect(r.eligible.map((e) => e.model)).toEqual(["a"]);
  });
});
