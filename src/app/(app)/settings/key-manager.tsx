"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Card, Input } from "@/components/ui";
import { createApiKey, revokeApiKey } from "../actions";

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function KeyManager({ keys }: { keys: KeyRow[] }) {
  const [name, setName] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function create() {
    startTransition(async () => {
      const res = await createApiKey(name);
      if ("key" in res) {
        setRevealed(res.key);
        setName("");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="key name (e.g. prod)" />
        <Button onClick={create} disabled={pending}>
          {pending ? "…" : "Generate"}
        </Button>
      </div>

      {revealed && (
        <Card className="border-ring p-3">
          <div className="text-xs text-muted-foreground">
            Copy this now — it is shown once. Only its hash is stored.
          </div>
          <code className="num mt-1 block break-all text-sm text-[hsl(var(--pass))]">{revealed}</code>
        </Card>
      )}

      <Card className="divide-y divide-border">
        {keys.length === 0 && <div className="px-4 py-4 text-sm text-muted-foreground">No keys yet.</div>}
        {keys.map((k) => (
          <div key={k.id} className="flex items-center justify-between px-4 py-3 text-sm">
            <div>
              <div className="flex items-center gap-2">
                <span>{k.name}</span>
                <code className="num text-xs text-muted-foreground">{k.prefix}…</code>
                {k.revokedAt && <Badge tone="fail">revoked</Badge>}
              </div>
              <div className="num mt-0.5 text-xs text-muted-foreground">
                {k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleString()}` : "never used"}
              </div>
            </div>
            {!k.revokedAt && (
              <Button variant="ghost" onClick={() => startTransition(() => revokeApiKey(k.id))}>
                revoke
              </Button>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}
