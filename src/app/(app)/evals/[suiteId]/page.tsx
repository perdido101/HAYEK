import { createClient } from "@/lib/supabase/server";
import { ComparisonTable, type Cell, type Column, type EvalRow, type ModelOption } from "./comparison";

export const dynamic = "force-dynamic";

function median(xs: number[]): number | null {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : Math.round((v[mid - 1]! + v[mid]!) / 2);
}

export default async function SuitePage({ params }: { params: Promise<{ suiteId: string }> }) {
  const { suiteId } = await params;
  const supabase = await createClient();

  const { data: suite } = await supabase.from("suites").select("id, name").eq("id", suiteId).maybeSingle();
  if (!suite) return <div className="text-sm text-muted-foreground">Suite not found.</div>;

  const { data: evalRows } = await supabase
    .from("evals")
    .select("id, name, tags, source_correction_id")
    .eq("suite_id", suiteId)
    .order("created_at", { ascending: true });
  const evals = (evalRows ?? []) as {
    id: string;
    name: string;
    tags: string[];
    source_correction_id: string | null;
  }[];

  // registry models available to run against
  const { data: modelRows } = await supabase.from("models").select("id, model_id, label");
  const models: ModelOption[] = (modelRows ?? []).map((m) => ({
    id: m.id as string,
    modelId: m.model_id as string,
    label: (m.label as string) ?? (m.model_id as string),
  }));

  // latest run per model for this suite
  const { data: runRows } = await supabase
    .from("runs")
    .select("id, model, adapter, pass_rate, cost, started_at, finished_at")
    .eq("suite_id", suiteId)
    .order("started_at", { ascending: false });
  type RunRow = NonNullable<typeof runRows>[number];
  const latestByModel = new Map<string, RunRow>();
  for (const r of runRows ?? []) if (!latestByModel.has(r.model as string)) latestByModel.set(r.model as string, r);
  const runIds = [...latestByModel.values()].map((r) => r.id as string);

  const { data: resultRows } = runIds.length
    ? await supabase
        .from("run_results")
        .select("id, run_id, eval_id, passed, score, latency_ms, error")
        .in("run_id", runIds)
    : { data: [] };
  const results = (resultRows ?? []) as {
    id: string;
    run_id: string;
    eval_id: string;
    passed: boolean;
    score: number | null;
    latency_ms: number | null;
    error: string | null;
  }[];

  // columns (one per model with a run) + header stats
  const columns: Column[] = [...latestByModel.values()].map((run) => {
    const rrs = results.filter((r) => r.run_id === run!.id);
    return {
      model: run!.model as string,
      runId: run!.id as string,
      passRate: (run!.pass_rate as number) ?? 0,
      cost: (run!.cost as number) ?? 0,
      medianLatency: median(rrs.map((r) => r.latency_ms ?? 0)),
    };
  });

  // cell matrix keyed by `${evalId}::${model}`
  const cells: Record<string, Cell> = {};
  for (const run of latestByModel.values()) {
    for (const r of results.filter((x) => x.run_id === run!.id)) {
      cells[`${r.eval_id}::${run!.model}`] = {
        passed: r.passed,
        score: r.score,
        latencyMs: r.latency_ms,
        error: r.error,
        runResultId: r.id,
      };
    }
  }

  // ---- provenance chain: eval -> correction -> author -> trace ----
  const sourceIds = evals.map((e) => e.source_correction_id).filter((x): x is string => !!x);
  const provByEval: Record<string, EvalRow["provenance"]> = {};
  if (sourceIds.length) {
    const { data: corr } = await supabase
      .from("corrections")
      .select("id, corrected_output, reason, created_at, author, traces(model, created_at)")
      .in("id", sourceIds);
    const authorIds = [...new Set((corr ?? []).map((c) => c.author).filter(Boolean))] as string[];
    const { data: profs } = authorIds.length
      ? await supabase.from("profiles").select("id, display_name, email").in("id", authorIds)
      : { data: [] };
    const nameById = new Map((profs ?? []).map((p) => [p.id as string, (p.display_name || p.email) as string]));
    const byCorrId = new Map((corr ?? []).map((c) => [c.id as string, c]));

    for (const e of evals) {
      if (!e.source_correction_id) continue;
      const c = byCorrId.get(e.source_correction_id);
      if (!c) continue;
      const trace = c.traces as unknown as { model: string; created_at: string } | null;
      provByEval[e.id] = {
        correctionId: c.id as string,
        correctedOutput: c.corrected_output as string,
        reason: (c.reason as string | null) ?? null,
        author: c.author ? nameById.get(c.author as string) ?? "a reviewer" : "a reviewer",
        correctedAt: c.created_at as string,
        traceModel: trace?.model ?? null,
      };
    }
  }

  const evalsOut: EvalRow[] = evals.map((e) => ({
    id: e.id,
    name: e.name,
    tags: e.tags ?? [],
    provenance: provByEval[e.id] ?? null,
  }));

  return (
    <ComparisonTable suiteId={suiteId} suiteName={suite.name as string} evals={evalsOut} models={models} columns={columns} cells={cells} />
  );
}
