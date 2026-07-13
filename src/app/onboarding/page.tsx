"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button, Card, Input, Label } from "@/components/ui";

export default function OnboardingPage() {
  const router = useRouter();
  const supabase = createClient();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // create_org() is a SECURITY DEFINER RPC: it makes the org and the owner
    // membership atomically, so RLS never sees a half-built org.
    const { error } = await supabase.rpc("create_org", { org_name: name });
    setBusy(false);
    if (error) return setError(error.message);
    router.push("/");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Name your vault</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          An org is your trust boundary. Everything you capture lives inside it.
        </p>
      </div>
      <Card className="p-5">
        <form onSubmit={create} className="flex flex-col gap-3">
          <div>
            <Label htmlFor="org">organization name</Label>
            <Input id="org" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </div>
          {error && <p className="text-xs text-[hsl(var(--fail))]">{error}</p>}
          <Button type="submit" disabled={busy}>
            {busy ? "…" : "Create"}
          </Button>
        </form>
      </Card>
    </main>
  );
}
