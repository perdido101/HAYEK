import { createClient } from "@/lib/supabase/server";
import { classifyRun, type CellStatus } from "@/core";
import { ChoiceGrid, type GridModel, type GridProvider, type GridTask } from "./choice-grid";

export const dynamic = "force-dynamic";

const DEFAULT_MIN_PASS = 0.8;
const DEFAULT_FRESHNESS = 30;

export default async function ChoicePage() {
  const supabase = await createClient();
  const nowMs = Date.now();

  // tasks that have a suite (the grid's rows)
  const { data: suiteRows } = await supabase
    .from("suites")
    .select("id, name, task_id, tasks(name)")
    .not("task_id", "is", null);
  const suites = (suiteRows ?? []).map((s) => ({
    suiteId: s.id as string,
    taskId: s.task_id as string,
    taskName: ((s.tasks as unknown as { name: string } | null)?.name ?? (s.name as string)) as string,
  }));

  // registry models (the grid's columns), grouped by provider
  const { data: modelRows } = await supabase
    .from("models")
    .select("model_id, label, provider_id, model_providers(id, label, adapter)");
  const models: GridModel[] = (modelRows ?? []).map((m) => {
    const p = m.model_providers as unknown as { id: string; label: string; adapter: string } | null;
    return {
      model: m.model_id as string,
      label: (m.label as string) ?? (m.model_id as string),
      providerId: p?.id ?? "unknown",
      providerLabel: p?.label ?? "unknown",
      adapter: p?.adapter ?? "openai",
    };
  });
  const providers: GridProvider[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m.providerId)) continue;
    seen.add(m.providerId);
    providers.push({ id: m.providerId, label: m.providerLabel, adapter: m.adapter });
  }

  // per-task policy thresholds
  const { data: policyRows } = await supabase
    .from("route_policies")
    .select("task_id, strategy, min_pass_rate, freshness_days, pinned_model, candidates");
  const policyByTask = new Map((policyRows ?? []).map((p) => [p.task_id as string, p]));

  // latest run per (suite, model) — the grid reads evidence, not traces
  const suiteIds = suites.map((s) => s.suiteId);
  const { data: runRows } = suiteIds.length
    ? await supabase
        .from("runs")
        .select("suite_id, model, pass_rate, finished_at, started_at")
        .in("suite_id", suiteIds)
        .order("started_at", { ascending: false })
    : { data: [] };
  const latest = new Map<string, { passRate: number; finishedAt: string }>();
  for (const r of runRows ?? []) {
    const key = `${r.suite_id}::${r.model}`;
    if (!latest.has(key)) {
      latest.set(key, {
        passRate: (r.pass_rate as number) ?? 0,
        finishedAt: (r.finished_at as string) ?? (r.started_at as string),
      });
    }
  }

  // build cell status matrix keyed by `${taskId}::${model}`
  const status: Record<string, CellStatus> = {};
  const tasks: GridTask[] = suites.map((s) => {
    const pol = policyByTask.get(s.taskId);
    const minPass = pol ? (pol.min_pass_rate as number) : DEFAULT_MIN_PASS;
    const fresh = pol ? (pol.freshness_days as number) : DEFAULT_FRESHNESS;
    for (const m of models) {
      const run = latest.get(`${s.suiteId}::${m.model}`) ?? null;
      status[`${s.taskId}::${m.model}`] = classifyRun(run, minPass, fresh, nowMs);
    }
    return {
      taskId: s.taskId,
      taskName: s.taskName,
      strategy: (pol?.strategy as GridTask["strategy"]) ?? "cheapest_passing",
      minPassRate: minPass,
      freshnessDays: fresh,
    };
  });

  return <ChoiceGrid tasks={tasks} models={models} providers={providers} status={status} />;
}
