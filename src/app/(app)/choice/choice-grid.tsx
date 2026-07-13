"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CellStatus } from "@/core";
import { saveRoutePolicy } from "../actions";

export interface GridProvider {
  id: string;
  label: string;
  adapter: string;
}
export interface GridModel {
  model: string;
  label: string;
  providerId: string;
  providerLabel: string;
  adapter: string;
}
export interface GridTask {
  taskId: string;
  taskName: string;
  strategy: "cheapest_passing" | "fastest_passing" | "pinned";
  minPassRate: number;
  freshnessDays: number;
}

const COLOR: Record<CellStatus, string> = {
  green: "hsl(152 58% 42%)",
  amber: "hsl(38 92% 52%)",
  red: "hsl(8 72% 54%)",
  grey: "hsl(215 12% 28%)",
};
const GLYPH: Record<CellStatus, string> = { green: "✓", amber: "~", red: "✕", grey: "·" };

export function ChoiceGrid({
  tasks,
  models,
  providers,
  status,
}: {
  tasks: GridTask[];
  models: GridModel[];
  providers: GridProvider[];
  status: Record<string, CellStatus>;
}) {
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  // columns ordered by provider so groups read left-to-right
  const cols = useMemo(
    () => [...models].sort((a, b) => a.providerLabel.localeCompare(b.providerLabel) || a.model.localeCompare(b.model)),
    [models],
  );

  const cell = (taskId: string, model: string): CellStatus => status[`${taskId}::${model}`] ?? "grey";
  const remaining = cols.filter((m) => !excluded.has(m.providerId));

  const { covered, uncovered } = useMemo(() => {
    const uncovered: string[] = [];
    let covered = 0;
    for (const t of tasks) {
      const ok = remaining.some((m) => cell(t.taskId, m.model) === "green");
      if (ok) covered += 1;
      else uncovered.push(t.taskName);
    }
    return { covered, uncovered };
  }, [tasks, remaining, status]);

  const excludedLabels = providers.filter((p) => excluded.has(p.id)).map((p) => p.label);

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-lg font-semibold tracking-tight">Choice test</h1>

      {/* THE BANNER — loudest thing on the page */}
      <div
        className="rounded-md border p-5"
        style={{
          borderColor: uncovered.length ? COLOR.red : COLOR.green,
          background: uncovered.length ? "hsl(8 72% 54% / 0.10)" : "hsl(152 58% 42% / 0.10)",
        }}
      >
        <div className="text-xs tracking-wider text-muted-foreground">
          {excludedLabels.length ? `WITHOUT ${excludedLabels.join(" + ").toUpperCase()}` : "ALL PROVIDERS AVAILABLE"}
        </div>
        <div className="num mt-2 text-2xl font-semibold">
          {covered} of {tasks.length} tasks still have a passing model.
        </div>
        {uncovered.length > 0 && (
          <div className="num mt-1 text-sm" style={{ color: COLOR.red }}>
            {uncovered.length} {uncovered.length === 1 ? "task has" : "tasks have"} no alternative: {uncovered.join(", ")}
          </div>
        )}
      </div>

      {/* the counterfactual control — remove a SET of providers */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">remove:</span>
        {providers.map((p) => {
          const off = excluded.has(p.id);
          return (
            <button
              key={p.id}
              onClick={() => {
                const next = new Set(excluded);
                off ? next.delete(p.id) : next.add(p.id);
                setExcluded(next);
              }}
              className="num rounded border px-2 py-1 text-xs"
              style={
                off
                  ? { borderColor: COLOR.red, color: COLOR.red, textDecoration: "line-through", background: "hsl(8 72% 54% / 0.08)" }
                  : { borderColor: "hsl(var(--border))", color: "hsl(var(--muted-foreground))" }
              }
            >
              {p.label} <span className="opacity-60">· {p.adapter}</span>
            </button>
          );
        })}
        {excluded.size > 0 && (
          <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setExcluded(new Set())}>
            reset
          </button>
        )}
      </div>

      {/* the grid */}
      <div className="overflow-x-auto rounded-md border border-border bg-panel">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 bg-panel px-3 py-2 text-left text-xs font-normal text-muted-foreground">task</th>
              {cols.map((m) => {
                const off = excluded.has(m.providerId);
                return (
                  <th key={m.model} className="px-2 py-2 text-center" style={off ? { opacity: 0.3 } : undefined}>
                    <div className="num text-xs text-foreground">{m.model}</div>
                    <div className="text-[10px] text-muted-foreground">{m.providerLabel}</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="num">
            {tasks.map((t) => (
              <tr key={t.taskId} className="border-t border-border/50">
                <td className="sticky left-0 bg-panel px-3 py-2">
                  <div className="text-foreground">{t.taskName}</div>
                  <PolicyChip task={t} models={cols} />
                </td>
                {cols.map((m) => {
                  const s = cell(t.taskId, m.model);
                  const off = excluded.has(m.providerId);
                  return (
                    <td key={m.model} className="px-2 py-1 text-center">
                      <span
                        title={s}
                        className="inline-flex h-7 w-9 items-center justify-center rounded text-sm font-bold text-black"
                        style={{ background: COLOR[s], opacity: off ? 0.18 : 1, color: s === "grey" ? "hsl(215 10% 60%)" : "black" }}
                      >
                        {GLYPH[s]}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
            {tasks.length === 0 && (
              <tr>
                <td colSpan={cols.length + 1} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  No tasks with a suite yet. Bind a suite to a task and run it.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* legend */}
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        {(["green", "amber", "red", "grey"] as CellStatus[]).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded" style={{ background: COLOR[s] }} />
            {s === "green" ? "passing + fresh" : s === "amber" ? "passing but stale" : s === "red" ? "failing" : "never evaluated"}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Compact, editable policy: strategy + min pass %. Candidates default to all. */
function PolicyChip({ task, models }: { task: GridTask; models: GridModel[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [strategy, setStrategy] = useState(task.strategy);
  const [minPass, setMinPass] = useState(Math.round(task.minPassRate * 100));
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <button className="num mt-0.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setOpen(true)}>
        {task.strategy.replace("_passing", "")} · ≥{Math.round(task.minPassRate * 100)}% ✎
      </button>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-1">
      <select
        className="num rounded border border-border bg-background px-1 py-0.5 text-[11px]"
        value={strategy}
        onChange={(e) => setStrategy(e.target.value as GridTask["strategy"])}
      >
        <option value="cheapest_passing">cheapest</option>
        <option value="fastest_passing">fastest</option>
        <option value="pinned">pinned</option>
      </select>
      <input
        type="number"
        min={0}
        max={100}
        value={minPass}
        onChange={(e) => setMinPass(Number(e.target.value))}
        className="num w-12 rounded border border-border bg-background px-1 py-0.5 text-[11px]"
      />
      <button
        className="num rounded border border-ring px-1 py-0.5 text-[11px]"
        disabled={pending}
        onClick={() =>
          start(async () => {
            await saveRoutePolicy({
              taskId: task.taskId,
              strategy,
              minPassRate: minPass / 100,
              freshnessDays: task.freshnessDays,
              candidates: models.map((m) => m.model),
            });
            setOpen(false);
            router.refresh();
          })
        }
      >
        save
      </button>
    </div>
  );
}
