/**
 * Phase 0 placeholder. The real landing view — the loop, five live cards — is
 * built after the schema/RLS is approved. This just proves the scaffold runs.
 */
const LOOP = ["CAPTURE", "EVALS", "ROUTER", "DISTILL", "AUDIT"] as const;

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">HAYEK</h1>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          The trust boundary for your intelligence exhaust. Capture it inside
          your own tenant and compound it into an asset you own.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        {LOOP.map((step, i) => (
          <span key={step} className="flex items-center gap-2">
            <span className="num rounded border border-border bg-panel px-2 py-1 tracking-wider text-foreground">
              {step}
            </span>
            {i < LOOP.length - 1 && <span className="text-muted-foreground">→</span>}
          </span>
        ))}
      </div>

      <p className="num text-xs text-muted-foreground">
        phase 0 · scaffold · schema + rls · core + guard test
      </p>
    </main>
  );
}
