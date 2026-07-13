import type { Assertion, AssertionResult, JudgeFn } from "./types";
import { validateJsonSchema } from "./jsonschema";

/**
 * Assertion evaluators. Deterministic ones are pure and cheap. The llmJudge one
 * is async and calls the INJECTED judge — core never talks to a provider itself.
 * Every result carries a `reason`: an unexplained pass/fail gets ignored.
 */

/** Deterministic assertions — no I/O, no cost. */
export function evalDeterministic(assertion: Assertion, output: string): AssertionResult {
  switch (assertion.type) {
    case "contains": {
      const passed = output.includes(assertion.value);
      return mk("contains", passed, `output ${passed ? "contains" : "does not contain"} "${trunc(assertion.value)}"`);
    }
    case "notContains": {
      const passed = !output.includes(assertion.value);
      return mk("notContains", passed, `output ${passed ? "does not contain" : "contains"} "${trunc(assertion.value)}"`);
    }
    case "regex": {
      let re: RegExp;
      try {
        re = new RegExp(assertion.value, assertion.flags);
      } catch (e) {
        return mk("regex", false, `invalid regex: ${String(e)}`);
      }
      const passed = re.test(output);
      return mk("regex", passed, `regex /${trunc(assertion.value)}/ ${passed ? "matched" : "did not match"}`);
    }
    case "jsonSchema": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch {
        return mk("jsonSchema", false, "output is not valid JSON");
      }
      const { valid, errors } = validateJsonSchema(parsed, assertion.schema);
      return mk("jsonSchema", valid, valid ? "matches schema" : `schema errors: ${errors.slice(0, 5).join("; ")}`);
    }
    case "llmJudge":
      // handled by evalJudge — never reached here.
      return mk("llmJudge", false, "llmJudge must be run via evalJudge");
  }
}

/**
 * llmJudge — asks the injected judge to grade the output against a rubric and
 * return JSON {score, reason}. Lenient parsing: if the judge doesn't return
 * clean JSON we still try to salvage a score, and we always keep a reason.
 */
export async function evalJudge(
  assertion: Extract<Assertion, { type: "llmJudge" }>,
  output: string,
  expectedBehavior: string | null,
  judge: JudgeFn,
): Promise<AssertionResult> {
  const rubric = assertion.rubric ?? expectedBehavior ?? "Grade whether the output is correct and helpful.";
  const threshold = assertion.threshold ?? 0.5;

  const messages = [
    {
      role: "system",
      content:
        "You are a strict evaluator. Grade the OUTPUT against the RUBRIC. " +
        'Respond with ONLY compact JSON: {"score": <number 0..1>, "reason": "<one sentence>"}. ' +
        "score 1 = fully satisfies the rubric, 0 = fails it.",
    },
    { role: "user", content: `RUBRIC:\n${rubric}\n\nOUTPUT:\n${output}` },
  ];

  let raw: string;
  try {
    raw = await judge(messages);
  } catch (e) {
    return mk("llmJudge", false, `judge call failed: ${String(e)}`);
  }

  const parsed = parseJudge(raw);
  if (!parsed) return mk("llmJudge", false, `judge returned unparseable response: ${trunc(raw, 80)}`);

  const passed = parsed.score >= threshold;
  return { type: "llmJudge", passed, score: clamp01(parsed.score), reason: parsed.reason || "(judge gave no reason)" };
}

function parseJudge(raw: string): { score: number; reason: string } | null {
  // Prefer a JSON object anywhere in the response.
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as { score?: unknown; reason?: unknown };
      if (typeof obj.score === "number") {
        return { score: obj.score, reason: typeof obj.reason === "string" ? obj.reason : "" };
      }
    } catch {
      /* fall through */
    }
  }
  // Salvage a bare number 0..1 if present.
  const num = raw.match(/\b(0(?:\.\d+)?|1(?:\.0+)?)\b/);
  if (num) return { score: Number(num[1]), reason: raw.trim().slice(0, 200) };
  return null;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const trunc = (s: string, n = 40) => (s.length > n ? s.slice(0, n) + "…" : s);

function mk(type: AssertionResult["type"], passed: boolean, reason: string): AssertionResult {
  return { type, passed, score: passed ? 1 : 0, reason };
}
