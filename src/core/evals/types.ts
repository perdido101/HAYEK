import { z } from "zod";
import { MessageSchema } from "../trace/schema";

/**
 * Eval Vault domain types. Pure: the runner interprets these, it performs no
 * I/O. The model under test and the judge are INJECTED as functions, so core
 * never calls a provider (keeps it pure AND makes the runner unit-testable).
 */

// --- assertions --------------------------------------------------------------
export const AssertionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("contains"), value: z.string() }),
  z.object({ type: z.literal("notContains"), value: z.string() }),
  z.object({ type: z.literal("regex"), value: z.string(), flags: z.string().optional() }),
  z.object({ type: z.literal("jsonSchema"), schema: z.record(z.string(), z.unknown()) }),
  z.object({
    type: z.literal("llmJudge"),
    // The rubric the judge grades against; defaults to the eval's expected_behavior.
    rubric: z.string().optional(),
    // score >= threshold passes. Default 0.5.
    threshold: z.number().min(0).max(1).optional(),
  }),
]);
export type Assertion = z.infer<typeof AssertionSchema>;
export type AssertionType = Assertion["type"];

export const EvalSchema = z.object({
  id: z.string(),
  name: z.string(),
  input_messages: z.array(MessageSchema),
  expected_behavior: z.string().nullable().default(null),
  assertions: z.array(AssertionSchema),
  tags: z.array(z.string()).default([]),
});
export type Eval = z.infer<typeof EvalSchema>;

export interface Suite {
  id: string;
  name: string;
}

// --- injected functions ------------------------------------------------------
/** The model under test. Returns its output + token usage (for cost). */
export type ModelFn = (
  messages: { role: string; content: string }[],
) => Promise<ModelInvocation>;

export interface ModelInvocation {
  output: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

/** The judge model. Returns raw text; core parses {score, reason} out of it. */
export type JudgeFn = (messages: { role: string; content: string }[]) => Promise<string>;

// --- results -----------------------------------------------------------------
export interface AssertionResult {
  type: AssertionType;
  passed: boolean;
  score: number; // 0..1
  reason: string; // ALWAYS present — a pass/fail with no explanation is untrustworthy
  skipped?: boolean; // true when short-circuited (a cheaper assertion already failed)
}

export interface EvalResult {
  eval_id: string;
  passed: boolean;
  score: number; // 0..1, mean of assertion scores
  output: string;
  assertion_results: AssertionResult[];
  latency_ms: number | null;
  error: string | null; // set if the model call itself threw; the run still completes
}

export interface RunReport {
  suite_id: string;
  model: string;
  pass_rate: number; // 0..1
  cost: number; // USD, from priceTrace over token usage
  price_table_version: string;
  per_eval_results: EvalResult[];
}
