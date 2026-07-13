import type {
  EligibleModel,
  Excluded,
  Resolution,
  RoutePolicy,
  RunEvidence,
} from "./types";

const DAY_MS = 86_400_000;

/**
 * resolveModel — the arbiter. Given a task's policy and the run evidence for
 * that task's suite, decide which model to route to.
 *
 * A model is ELIGIBLE only if it has a run (its latest) that is:
 *   - fresh   (finished within freshnessDays of `nowMs`), AND
 *   - passing (passRate >= minPassRate).
 * No run => never_evaluated. Old run => stale. Low run => below_threshold.
 *
 * If nothing is eligible, model is null with a reason. It NEVER falls back to a
 * default — admitting "no model qualifies" is the point.
 */
export function resolveModel(
  policy: RoutePolicy,
  runs: RunEvidence[],
  nowMs: number,
): Resolution {
  // latest run per model
  const latest = new Map<string, RunEvidence>();
  for (const r of runs) {
    const cur = latest.get(r.model);
    if (!cur || Date.parse(r.finishedAt) > Date.parse(cur.finishedAt)) latest.set(r.model, r);
  }

  const eligible: EligibleModel[] = [];
  const excluded: Excluded[] = [];

  for (const cand of policy.candidates) {
    const run = latest.get(cand.model);
    if (!run) {
      excluded.push({ model: cand.model, why: "never_evaluated", detail: "no run against this task's suite" });
      continue;
    }
    const ageDays = (nowMs - Date.parse(run.finishedAt)) / DAY_MS;
    if (ageDays > policy.freshnessDays) {
      excluded.push({
        model: cand.model,
        why: "stale",
        detail: `last run ${ageDays.toFixed(1)}d ago > ${policy.freshnessDays}d`,
      });
      continue;
    }
    if (run.passRate < policy.minPassRate) {
      excluded.push({
        model: cand.model,
        why: "below_threshold",
        detail: `pass rate ${(run.passRate * 100).toFixed(0)}% < ${(policy.minPassRate * 100).toFixed(0)}%`,
      });
      continue;
    }
    eligible.push({
      model: cand.model,
      passRate: run.passRate,
      cost: run.cost,
      medianLatencyMs: run.medianLatencyMs,
      ageDays,
    });
  }

  if (eligible.length === 0) {
    return { model: null, reason: noneReason(excluded, policy), eligible, excluded };
  }

  let chosen: EligibleModel | null;
  switch (policy.strategy) {
    case "cheapest_passing":
      chosen = pick(eligible, (a, b) => a.cost - b.cost || b.passRate - a.passRate || cmp(a.model, b.model));
      break;
    case "fastest_passing":
      chosen = pick(
        eligible,
        (a, b) => lat(a.medianLatencyMs) - lat(b.medianLatencyMs) || b.passRate - a.passRate || cmp(a.model, b.model),
      );
      break;
    case "pinned": {
      chosen = eligible.find((e) => e.model === policy.pinnedModel) ?? null;
      if (!chosen) {
        const why = excluded.find((e) => e.model === policy.pinnedModel);
        return {
          model: null,
          reason: `pinned model ${policy.pinnedModel ?? "(none set)"} is not eligible${why ? `: ${why.why}` : ""}`,
          eligible,
          excluded,
        };
      }
      break;
    }
  }

  return { model: chosen.model, reason: chosenReason(policy.strategy, chosen, eligible.length), eligible, excluded };
}

function pick(list: EligibleModel[], by: (a: EligibleModel, b: EligibleModel) => number): EligibleModel {
  return [...list].sort(by)[0]!;
}
function lat(x: number | null): number {
  return x == null ? Number.POSITIVE_INFINITY : x;
}
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function chosenReason(strategy: string, m: EligibleModel, n: number): string {
  const pct = `${(m.passRate * 100).toFixed(0)}%`;
  if (strategy === "cheapest_passing") return `cheapest_passing: ${m.model} at $${m.cost.toFixed(4)}/run (${pct}, ${n} eligible)`;
  if (strategy === "fastest_passing")
    return `fastest_passing: ${m.model} at ${m.medianLatencyMs == null ? "?" : `${m.medianLatencyMs}ms`} (${pct}, ${n} eligible)`;
  return `pinned: ${m.model} (${pct})`;
}

function noneReason(excluded: Excluded[], policy: RoutePolicy): string {
  if (policy.candidates.length === 0) return "no candidate models in policy";
  const counts = { never_evaluated: 0, stale: 0, below_threshold: 0 };
  for (const e of excluded) counts[e.why] += 1;
  const parts: string[] = [];
  if (counts.never_evaluated) parts.push(`${counts.never_evaluated} never evaluated`);
  if (counts.stale) parts.push(`${counts.stale} stale`);
  if (counts.below_threshold) parts.push(`${counts.below_threshold} below threshold`);
  return `no model currently qualifies for this task: ${parts.join(", ")}`;
}
