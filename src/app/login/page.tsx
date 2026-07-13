"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button, Card, Input, Label } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"in" | "up">("in");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const fn =
      mode === "in"
        ? supabase.auth.signInWithPassword({ email, password })
        : supabase.auth.signUp({ email, password });
    const { error } = await fn;
    setBusy(false);
    if (error) return setError(error.message);
    router.push("/");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">HAYEK</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {mode === "in" ? "Sign in to your vault." : "Create an account."}
        </p>
      </div>
      <Card className="p-5">
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div>
            <Label htmlFor="email">email</Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="password">password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
            />
          </div>
          {error && <p className="text-xs text-[hsl(var(--fail))]">{error}</p>}
          <Button type="submit" disabled={busy}>
            {busy ? "…" : mode === "in" ? "Sign in" : "Sign up"}
          </Button>
        </form>
      </Card>
      <button
        className="text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setMode(mode === "in" ? "up" : "in")}
      >
        {mode === "in" ? "Need an account? Sign up" : "Have an account? Sign in"}
      </button>
    </main>
  );
}
