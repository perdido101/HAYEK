import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Badge, Card } from "@/components/ui";

export const dynamic = "force-dynamic";

interface TraceRow {
  id: string;
  model: string;
  status_code: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_estimate: number | null;
  latency_ms: number | null;
  created_at: string;
}

function fmtCost(c: number | null) {
  if (c == null) return "—";
  return c === 0 ? "$0" : `$${c.toFixed(4)}`;
}

export default async function TracesPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("traces")
    .select("id, model, status_code, tokens_in, tokens_out, cost_estimate, latency_ms, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  const traces = (data ?? []) as TraceRow[];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Traces</h1>
        <span className="num text-xs text-muted-foreground">{traces.length} shown</span>
      </div>

      {traces.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No traces yet. Point an SDK at <code className="num text-foreground">/v1</code> and make a call — see the README curl.
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-normal">when</th>
                <th className="px-3 py-2 font-normal">model</th>
                <th className="px-3 py-2 font-normal">status</th>
                <th className="px-3 py-2 text-right font-normal">tok in</th>
                <th className="px-3 py-2 text-right font-normal">tok out</th>
                <th className="px-3 py-2 text-right font-normal">cost</th>
                <th className="px-3 py-2 text-right font-normal">latency</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="num">
              {traces.map((t) => {
                const ok = (t.status_code ?? 0) < 400;
                return (
                  <tr key={t.id} className="border-b border-border/50 hover:bg-muted/40">
                    <td className="px-3 py-2 text-muted-foreground">
                      {new Date(t.created_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">{t.model}</td>
                    <td className="px-3 py-2">
                      <Badge tone={ok ? "pass" : "fail"}>{t.status_code ?? "—"}</Badge>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.tokens_in ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.tokens_out ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtCost(t.cost_estimate)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {t.latency_ms == null ? "—" : `${t.latency_ms}ms`}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Link href={`/inbox?trace=${t.id}`} className="text-xs text-[hsl(var(--accent))] hover:underline">
                        correct →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
