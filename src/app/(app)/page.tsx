import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui";

async function count(table: string): Promise<number> {
  const supabase = await createClient();
  const { count } = await supabase.from(table).select("*", { count: "exact", head: true });
  return count ?? 0;
}

function LoopCard({
  step,
  label,
  value,
  hint,
  href,
}: {
  step: string;
  label: string;
  value: string;
  hint: string;
  href: string;
}) {
  return (
    <Link href={href}>
      <Card className="flex h-full flex-col gap-3 p-4 transition-colors hover:border-ring">
        <div className="num text-xs tracking-wider text-muted-foreground">{step}</div>
        <div className="num text-3xl font-semibold tabular-nums">{value}</div>
        <div className="text-sm text-foreground">{label}</div>
        <div className="mt-auto text-xs text-muted-foreground">{hint}</div>
      </Card>
    </Link>
  );
}

export default async function Dashboard() {
  const [traces, corrections] = await Promise.all([count("traces"), count("corrections")]);

  return (
    <div className="flex flex-col gap-8">
      <section className="rounded-md border border-border bg-panel p-6">
        <div className="text-xs tracking-wider text-muted-foreground">KNOWLEDGE RETAINED</div>
        <div className="num mt-2 text-4xl font-semibold tabular-nums">{corrections}</div>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          corrections that would otherwise have belonged to your vendor.
        </p>
      </section>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <LoopCard step="01 · CAPTURE" label="traces captured" value={String(traces)} hint="proxied model calls" href="/traces" />
        <LoopCard step="02 · EVALS" label="corrections" value={String(corrections)} hint="promote to evals →" href="/inbox" />
        <LoopCard step="03 · ROUTER" label="pass-rate by model" value="—" hint="Phase 3" href="/" />
        <LoopCard step="04 · DISTILL" label="rows distilled" value="—" hint="Phase 4" href="/" />
        <LoopCard step="05 · AUDIT" label="exposure grade" value="—" hint="Phase 5" href="/" />
      </section>
    </div>
  );
}
