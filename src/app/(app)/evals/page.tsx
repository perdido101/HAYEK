import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Badge, Card } from "@/components/ui";
import { NewSuite } from "./new-suite";

export const dynamic = "force-dynamic";

export default async function EvalsPage() {
  const supabase = await createClient();
  const { data: suites } = await supabase
    .from("suites")
    .select("id, name, created_at, evals(count)")
    .order("created_at", { ascending: false });

  const rows = (suites ?? []).map((s) => ({
    id: s.id as string,
    name: s.name as string,
    evalCount: ((s.evals as unknown as { count: number }[])?.[0]?.count as number) ?? 0,
  }));

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Eval suites</h1>
        <NewSuite />
      </div>

      <Card className="divide-y divide-border">
        {rows.length === 0 && (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            No suites yet. Promote a correction from the inbox, or create a suite and add evals.
          </div>
        )}
        {rows.map((s) => (
          <Link key={s.id} href={`/evals/${s.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-muted/40">
            <span className="text-sm">{s.name}</span>
            <Badge>{s.evalCount} evals</Badge>
          </Link>
        ))}
      </Card>
    </div>
  );
}
