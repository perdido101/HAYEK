import { priceTrace, PRICE_TABLE_VERSION } from "../trace/cost";
import { evalDeterministic, evalJudge } from "./assertions";
import type {
  AssertionResult,
  Eval,
  EvalResult,
  JudgeFn,
  ModelFn,
  RunReport,
  Suite,
} from "./types";

/**
 * runSuite — run every eval in a suite against one model, return a RunReport.
 * Pure orchestration over injected modelFn/judgeFn.
 *
 * - Deterministic assertions run FIRST and short-circuit: if one fails, the
 *   eval is already failing, so we skip the (slow, paid) judge assertions.
 * - A model call that throws fails ONLY that eval — the run completes.
 */
export async function runSuite(
  suite: Suite,
  evals: Eval[],
  model: string,
  modelFn: ModelFn,
  judgeFn: JudgeFn,
): Promise<RunReport> {
  const results: EvalResult[] = [];
  let costTotal = 0;

  for (const ev of evals) {
    const { result, cost } = await runEval(ev, model, modelFn, judgeFn);
    results.push(result);
    costTotal += cost;
  }

  const passed = results.filter((r) => r.passed).length;
  const pass_rate = results.length ? passed / results.length : 0;

  return {
    suite_id: suite.id,
    model,
    pass_rate: round(pass_rate, 4),
    cost: round(costTotal, 6),
    price_table_version: PRICE_TABLE_VERSION,
    per_eval_results: results,
  };
}

async function runEval(
  ev: Eval,
  model: string,
  modelFn: ModelFn,
  judgeFn: JudgeFn,
): Promise<{ result: EvalResult; cost: number }> {
  const startedAt = nowMs();

  // 1) run the model under test. A throw fails only this eval.
  let output = "";
  let cost = 0;
  try {
    const inv = await modelFn(ev.input_messages);
    output = inv.output;
    cost = priceTrace(model, inv.tokensIn ?? null, inv.tokensOut ?? null).cost_estimate;
  } catch (e) {
    return {
      cost: 0,
      result: {
        eval_id: ev.id,
        passed: false,
        score: 0,
        output: "",
        assertion_results: [],
        latency_ms: elapsed(startedAt),
        error: String(e instanceof Error ? e.message : e),
      },
    };
  }

  // 2) deterministic assertions first.
  const deterministic = ev.assertions.filter((a) => a.type !== "llmJudge");
  const judged = ev.assertions.filter((a) => a.type === "llmJudge");

  const assertion_results: AssertionResult[] = [];
  let anyFailed = false;
  for (const a of deterministic) {
    const r = evalDeterministic(a, output);
    assertion_results.push(r);
    if (!r.passed) anyFailed = true;
  }

  // 3) only reach for the judge if the cheap checks all passed.
  if (anyFailed) {
    for (const a of judged) {
      assertion_results.push({
        type: "llmJudge",
        passed: false,
        score: 0,
        skipped: true,
        reason: "skipped: a deterministic assertion already failed",
      });
    }
  } else {
    for (const a of judged) {
      if (a.type !== "llmJudge") continue; // narrow
      const r = await evalJudge(a, output, ev.expected_behavior, judgeFn);
      assertion_results.push(r);
      if (!r.passed) anyFailed = true;
    }
  }

  const scored = assertion_results.filter((r) => !r.skipped);
  const score = scored.length ? scored.reduce((s, r) => s + r.score, 0) / scored.length : 1;

  return {
    cost,
    result: {
      eval_id: ev.id,
      passed: !anyFailed,
      score: round(score, 4),
      output,
      assertion_results,
      latency_ms: elapsed(startedAt),
      error: null,
    },
  };
}

// performance.now() is available in Node and Edge; guard for exotic runtimes.
function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : 0;
}
function elapsed(start: number): number | null {
  return typeof performance !== "undefined" ? Math.round(performance.now() - start) : null;
}
function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
