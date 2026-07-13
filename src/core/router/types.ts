/**
 * Router domain types. resolveModel is pure and unit-tested — it decides which
 * model a task routes to based ONLY on run evidence, and it will return
 * model=null rather than route to a model that hasn't earned it. That refusal
 * is the trust proposition; do not add a fallback.
 */

export type RouteStrategy = "cheapest_passing" | "fastest_passing" | "pinned";

export interface ModelRef {
  model: string;
}

export interface RoutePolicy {
  candidates: ModelRef[];
  strategy: RouteStrategy;
  pinnedModel: string | null;
  minPassRate: number; // 0..1
  freshnessDays: number;
}

/** One run's evidence for a (task's suite, model). Caller supplies the latest. */
export interface RunEvidence {
  model: string;
  passRate: number; // 0..1
  cost: number; // USD per run
  medianLatencyMs: number | null;
  finishedAt: string; // ISO
}

export type ExcludeReason = "never_evaluated" | "stale" | "below_threshold";

export interface Excluded {
  model: string;
  why: ExcludeReason;
  detail: string;
}

export interface EligibleModel {
  model: string;
  passRate: number;
  cost: number;
  medianLatencyMs: number | null;
  ageDays: number;
}

export interface Resolution {
  /** null = nothing qualifies. The system admits it rather than pretending. */
  model: string | null;
  reason: string;
  eligible: EligibleModel[];
  excluded: Excluded[];
}
