import { describe, it, expect, vi } from "vitest";
import { runSuite } from "./runner";
import { evalDeterministic } from "./assertions";
import { validateJsonSchema } from "./jsonschema";
import type { Eval, JudgeFn, ModelFn, Suite } from "./types";

const suite: Suite = { id: "suite-1", name: "S" };
const constModel = (output: string, tokensIn = 10, tokensOut = 5): ModelFn => async () => ({
  output,
  tokensIn,
  tokensOut,
});
const okJudge: JudgeFn = async () => JSON.stringify({ score: 1, reason: "looks right" });

function ev(partial: Partial<Eval> & Pick<Eval, "id" | "assertions">): Eval {
  return {
    name: partial.id,
    input_messages: [{ role: "user", content: "q" }],
    expected_behavior: null,
    tags: [],
    ...partial,
  } as Eval;
}

describe("deterministic assertions", () => {
  it("contains / notContains", () => {
    expect(evalDeterministic({ type: "contains", value: "cat" }, "the cat").passed).toBe(true);
    expect(evalDeterministic({ type: "contains", value: "dog" }, "the cat").passed).toBe(false);
    expect(evalDeterministic({ type: "notContains", value: "dog" }, "the cat").passed).toBe(true);
    expect(evalDeterministic({ type: "notContains", value: "cat" }, "the cat").passed).toBe(false);
  });

  it("regex, and a bad pattern fails gracefully with a reason", () => {
    expect(evalDeterministic({ type: "regex", value: "^a\\d+$" }, "a42").passed).toBe(true);
    expect(evalDeterministic({ type: "regex", value: "^a\\d+$" }, "b42").passed).toBe(false);
    const bad = evalDeterministic({ type: "regex", value: "(" }, "x");
    expect(bad.passed).toBe(false);
    expect(bad.reason).toMatch(/invalid regex/);
  });

  it("jsonSchema: valid, invalid shape, and non-JSON", () => {
    const schema = { type: "object", required: ["a"], properties: { a: { type: "number" } } };
    expect(evalDeterministic({ type: "jsonSchema", schema }, '{"a":1}').passed).toBe(true);
    expect(evalDeterministic({ type: "jsonSchema", schema }, '{"a":"x"}').passed).toBe(false);
    expect(evalDeterministic({ type: "jsonSchema", schema }, "not json").passed).toBe(false);
    expect(evalDeterministic({ type: "jsonSchema", schema }, "{}").reason).toMatch(/required/);
  });
});

describe("validateJsonSchema", () => {
  it("handles nested objects, arrays, enum, and integer", () => {
    const schema = {
      type: "object",
      required: ["items", "kind"],
      properties: {
        kind: { enum: ["a", "b"] },
        count: { type: "integer" },
        items: { type: "array", items: { type: "string" } },
      },
    };
    expect(validateJsonSchema({ kind: "a", count: 3, items: ["x"] }, schema).valid).toBe(true);
    expect(validateJsonSchema({ kind: "c", count: 3.5, items: [1] }, schema).errors.length).toBeGreaterThan(0);
  });
});

describe("runSuite", () => {
  it("passes an eval whose deterministic + judge assertions all pass", async () => {
    const evals = [
      ev({ id: "e1", assertions: [{ type: "contains", value: "Paris" }, { type: "llmJudge" }] }),
    ];
    const report = await runSuite(suite, evals, "gpt-4o", constModel("Paris is the capital."), okJudge);
    expect(report.pass_rate).toBe(1);
    expect(report.per_eval_results[0]!.passed).toBe(true);
    expect(report.per_eval_results[0]!.assertion_results.map((r) => r.type)).toEqual(["contains", "llmJudge"]);
  });

  it("computes cost from token usage via the price table", async () => {
    // gpt-4o: $2.5/1M in, $10/1M out. 1000 in, 1000 out.
    const evals = [ev({ id: "e1", assertions: [{ type: "contains", value: "x" }] })];
    const report = await runSuite(suite, evals, "gpt-4o", constModel("x", 1000, 1000), okJudge);
    expect(report.cost).toBeCloseTo(2.5 / 1e3 + 10 / 1e3, 9);
  });

  it("short-circuits: a failing deterministic assertion skips the judge (no judge call, no cost)", async () => {
    const judge = vi.fn<JudgeFn>(async () => JSON.stringify({ score: 1, reason: "n/a" }));
    const evals = [
      ev({ id: "e1", assertions: [{ type: "contains", value: "MISSING" }, { type: "llmJudge" }] }),
    ];
    const report = await runSuite(suite, evals, "gpt-4o", constModel("nothing here"), judge);
    expect(judge).not.toHaveBeenCalled(); // the whole point: don't pay for the judge
    const res = report.per_eval_results[0]!;
    expect(res.passed).toBe(false);
    const judgeResult = res.assertion_results.find((r) => r.type === "llmJudge")!;
    expect(judgeResult.skipped).toBe(true);
    expect(judgeResult.reason).toMatch(/skipped/);
  });

  it("stores the judge's reason on a judged eval", async () => {
    const judge: JudgeFn = async () => JSON.stringify({ score: 0.2, reason: "missed the point" });
    const evals = [ev({ id: "e1", assertions: [{ type: "llmJudge", threshold: 0.5 }] })];
    const report = await runSuite(suite, evals, "gpt-4o", constModel("meh"), judge);
    const jr = report.per_eval_results[0]!.assertion_results[0]!;
    expect(jr.passed).toBe(false); // 0.2 < 0.5
    expect(jr.score).toBe(0.2);
    expect(jr.reason).toBe("missed the point");
  });

  it("salvages a bare-number judge response and never throws", async () => {
    const judge: JudgeFn = async () => "I'd give this a 0.9 overall.";
    const evals = [ev({ id: "e1", assertions: [{ type: "llmJudge" }] })];
    const report = await runSuite(suite, evals, "gpt-4o", constModel("ok"), judge);
    expect(report.per_eval_results[0]!.assertion_results[0]!.score).toBe(0.9);
  });

  it("completes the run when one eval's MODEL call throws — that eval fails, others still run", async () => {
    let call = 0;
    const flakyModel: ModelFn = async () => {
      call += 1;
      if (call === 1) throw new Error("model exploded");
      return { output: "Paris", tokensIn: 1, tokensOut: 1 };
    };
    const evals = [
      ev({ id: "e1", assertions: [{ type: "contains", value: "Paris" }] }),
      ev({ id: "e2", assertions: [{ type: "contains", value: "Paris" }] }),
    ];
    const report = await runSuite(suite, evals, "gpt-4o", flakyModel, okJudge);
    expect(report.per_eval_results).toHaveLength(2);
    expect(report.per_eval_results[0]!.passed).toBe(false);
    expect(report.per_eval_results[0]!.error).toMatch(/model exploded/);
    expect(report.per_eval_results[1]!.passed).toBe(true);
    expect(report.pass_rate).toBe(0.5);
  });

  it("treats a thrown judge as a failed assertion, not a crashed run", async () => {
    const judge: JudgeFn = async () => {
      throw new Error("judge 500");
    };
    const evals = [ev({ id: "e1", assertions: [{ type: "llmJudge" }] })];
    const report = await runSuite(suite, evals, "gpt-4o", constModel("x"), judge);
    expect(report.per_eval_results[0]!.passed).toBe(false);
    expect(report.per_eval_results[0]!.assertion_results[0]!.reason).toMatch(/judge call failed/);
  });
});
