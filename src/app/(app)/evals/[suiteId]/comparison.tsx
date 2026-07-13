"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card } from "@/components/ui";

export interface ModelOption {
  id: string;
  modelId: string;
  label: string;
}
export interface Column {
  model: string;
  runId: string;
  passRate: number;
  cost: number;
  medianLatency: number | null;
}
export interface Cell {
  passed: boolean;
  score: number | null;
  latencyMs: number | null;
  error: string | null;
  runResultId: string;
}
export interface EvalRow {
  id: string;
  name: string;
  tags: string[];
  provenance: {
    correctionId: string;
    correctedOutput: string;
    reason: string | null;
    author: string;
    correctedAt: string;
    traceModel: string | null;
  } | null;
}

export function ComparisonTable({
  suiteId,
  suiteName,
  evals,
  models,
  columns,
  cells,
}: {
  suiteId: string;
  suiteName: string;
  evals: EvalRow[];
  models: ModelOption[];
  columns: Column[];
  cells: Record<string, Cell>;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set(models.map((m) => m.id)));
  const [running, start] = useTransition();
  const [drawer, setDrawer] = useState<{ ev: EvalRow; model: string; cell?: Cell } | null>(null);
  const [diff, setDiff] = useState<[string, string] | null>(null);

  const cell = (evalId: string, model: string): Cell | undefined => cells[`${evalId}::${model}`];

  const visibleEvals = useMemo(() => {
    if (!diff) return evals;
    const [a, b] = diff;
    return evals.filter((e) => {
      const ca = cell(e.id, a);
      const cb = cell(e.id, b);
      return ca && cb && ca.passed !== cb.passed;
    });
  }, [diff, evals, cells]);

  async function run() {
    start(async () => {
      await fetch(`/api/v1/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ suite_id: suiteId, model_ids: [...selected] }),
      });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{suiteName}</h1>
          <p className="num text-xs text-muted-foreground">
            {evals.length} evals · {columns.length} models run
          </p>
        </div>
        <div className="flex items-center gap-2">
          {columns.length >= 2 && (
            <DiffPicker columns={columns} diff={diff} setDiff={setDiff} />
          )}
          <Button variant="pass" onClick={run} disabled={running || selected.size === 0 || evals.length === 0}>
            {running ? "running…" : `Run ${selected.size} model${selected.size === 1 ? "" : "s"}`}
          </Button>
        </div>
      </div>

      {/* model picker for the run */}
      <div className="flex flex-wrap gap-2">
        {models.length === 0 && (
          <Card className="px-3 py-2 text-xs text-muted-foreground">
            No models registered. Add a provider + model under KEYS.
          </Card>
        )}
        {models.map((m) => {
          const on = selected.has(m.id);
          return (
            <button
              key={m.id}
              onClick={() => {
                const next = new Set(selected);
                on ? next.delete(m.id) : next.add(m.id);
                setSelected(next);
              }}
              className={`num rounded border px-2 py-1 text-xs ${
                on ? "border-ring bg-muted text-foreground" : "border-border text-muted-foreground"
              }`}
            >
              {m.label}
            </button>
          );
        })}
      </div>

      {/* the table */}
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="sticky left-0 bg-panel px-3 py-2 text-left text-xs font-normal text-muted-foreground">
                eval
              </th>
              {columns.map((c) => (
                <th key={c.model} className="px-3 py-2 text-center">
                  <div className="num text-xs text-foreground">{c.model}</div>
                  <div className="num mt-1 flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
                    <span className={c.passRate >= 0.999 ? "text-[hsl(var(--pass))]" : c.passRate < 0.5 ? "text-[hsl(var(--fail))]" : ""}>
                      {Math.round(c.passRate * 100)}%
                    </span>
                    <span>·</span>
                    <span>${c.cost.toFixed(4)}</span>
                    <span>·</span>
                    <span>{c.medianLatency == null ? "—" : `${c.medianLatency}ms`}</span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="num">
            {visibleEvals.map((e) => (
              <tr key={e.id} className="border-b border-border/50">
                <td className="sticky left-0 max-w-[260px] truncate bg-panel px-3 py-2">
                  <span className="text-foreground">{e.name}</span>
                  {e.provenance && (
                    <span className="ml-2 text-[10px] text-muted-foreground">◆ from correction</span>
                  )}
                </td>
                {columns.map((c) => {
                  const cl = cell(e.id, c.model);
                  return (
                    <td key={c.model} className="px-2 py-1 text-center">
                      {cl ? (
                        <button
                          title={`score ${cl.score ?? "—"}${cl.error ? ` · ${cl.error}` : ""}`}
                          onClick={() => setDrawer({ ev: e, model: c.model, cell: cl })}
                          className={`inline-flex h-7 w-14 items-center justify-center rounded text-xs ${
                            cl.passed
                              ? "bg-[hsl(var(--pass)/0.16)] text-[hsl(var(--pass))]"
                              : "bg-[hsl(var(--fail)/0.16)] text-[hsl(var(--fail))] hover:bg-[hsl(var(--fail)/0.28)]"
                          }`}
                        >
                          {cl.passed ? "PASS" : "FAIL"}
                        </button>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {visibleEvals.length === 0 && (
              <tr>
                <td colSpan={columns.length + 1} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {diff ? "these two models agree on every eval" : "no evals yet — promote a correction"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {drawer && <ProvenanceDrawer data={drawer} onClose={() => setDrawer(null)} />}
    </div>
  );
}

function DiffPicker({
  columns,
  diff,
  setDiff,
}: {
  columns: Column[];
  diff: [string, string] | null;
  setDiff: (d: [string, string] | null) => void;
}) {
  if (diff) {
    return (
      <button className="num rounded border border-ring px-2 py-1 text-xs text-foreground" onClick={() => setDiff(null)}>
        diff: {diff[0]} vs {diff[1]} ✕
      </button>
    );
  }
  return (
    <select
      className="num rounded border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
      defaultValue=""
      onChange={(e) => {
        if (e.target.value) {
          const [a, b] = e.target.value.split("|");
          setDiff([a!, b!]);
        }
      }}
    >
      <option value="">diff two models…</option>
      {columns.flatMap((a, i) =>
        columns.slice(i + 1).map((b) => (
          <option key={`${a.model}|${b.model}`} value={`${a.model}|${b.model}`}>
            {a.model} vs {b.model}
          </option>
        )),
      )}
    </select>
  );
}

/** The demo: a failing cell walks back to the human correction that defined it. */
function ProvenanceDrawer({
  data,
  onClose,
}: {
  data: { ev: EvalRow; model: string; cell?: Cell };
  onClose: () => void;
}) {
  const { ev, model, cell } = data;
  const p = ev.provenance;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="h-full w-full max-w-md overflow-y-auto border-l border-border bg-panel p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <Badge tone={cell?.passed ? "pass" : "fail"}>{cell?.passed ? "PASS" : "FAIL"}</Badge>
          <button className="text-xs text-muted-foreground hover:text-foreground" onClick={onClose}>
            close ✕
          </button>
        </div>

        <div className="mt-4 space-y-1">
          <div className="text-xs tracking-wider text-muted-foreground">EVAL</div>
          <div className="text-sm">{ev.name}</div>
          <div className="num text-xs text-muted-foreground">
            {model} · score {cell?.score ?? "—"} · {cell?.latencyMs == null ? "—" : `${cell.latencyMs}ms`}
          </div>
          {cell?.error && <div className="text-xs text-[hsl(var(--fail))]">{cell.error}</div>}
        </div>

        <div className="my-4 border-t border-border" />

        {p ? (
          <div className="space-y-3">
            <div className="text-xs tracking-wider text-muted-foreground">WHY THIS EVAL EXISTS</div>
            <p className="text-sm text-foreground">
              {p.author} corrected {p.traceModel ? <span className="num">{p.traceModel}</span> : "a model"} on{" "}
              <span className="num">{new Date(p.correctedAt).toLocaleDateString()}</span>. This eval holds that model to
              their answer.
            </p>
            {p.reason && (
              <div>
                <div className="text-xs tracking-wider text-muted-foreground">REASON</div>
                <p className="text-sm text-muted-foreground">{p.reason}</p>
              </div>
            )}
            <div>
              <div className="text-xs tracking-wider text-muted-foreground">THE CORRECTED ANSWER (the gold)</div>
              <pre className="mt-1 whitespace-pre-wrap rounded border border-border bg-background px-3 py-2 text-sm">
                {p.correctedOutput}
              </pre>
            </div>
            <p className="text-[11px] text-muted-foreground">
              run_result → eval → correction → trace. Nobody else can show this, because nobody else has the correction.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">This eval was authored directly (no source correction).</p>
        )}
      </div>
    </div>
  );
}
