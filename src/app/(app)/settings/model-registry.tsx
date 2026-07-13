"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Input, Label } from "@/components/ui";
import { addModel, addModelProvider } from "../actions";

interface Provider {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string | null;
}
interface Model {
  id: string;
  providerId: string;
  modelId: string;
  label: string;
}

export function ModelRegistry({ providers, models }: { providers: Provider[]; models: Model[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  // add-provider form
  const [label, setLabel] = useState("");
  const [adapter, setAdapter] = useState<"anthropic" | "openai" | "openai_compatible">("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function submitProvider() {
    start(async () => {
      setErr(null);
      const res = await addModelProvider({ label, adapter, baseUrl, apiKey });
      if ("error" in res) setErr(res.error);
      else {
        setLabel("");
        setApiKey("");
        setBaseUrl("");
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>label</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. OpenAI prod" />
          </div>
          <div>
            <Label>adapter</Label>
            <select
              className="w-full rounded border border-input bg-background px-3 py-1.5 text-sm"
              value={adapter}
              onChange={(e) => setAdapter(e.target.value as typeof adapter)}
            >
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
              <option value="openai_compatible">openai_compatible</option>
            </select>
          </div>
          <div>
            <Label>base URL (optional; required for compatible)</Label>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…" />
          </div>
          <div>
            <Label>API key (encrypted at rest)</Label>
            <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" type="password" />
          </div>
        </div>
        {err && <p className="text-xs text-[hsl(var(--fail))]">{err}</p>}
        <div>
          <Button onClick={submitProvider} disabled={pending}>
            {pending ? "…" : "Add provider"}
          </Button>
        </div>
      </Card>

      {providers.map((p) => (
        <Card key={p.id} className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm">{p.label}</span>
              <Badge>{p.adapter}</Badge>
              {p.baseUrl && <span className="num text-xs text-muted-foreground">{p.baseUrl}</span>}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {models
              .filter((m) => m.providerId === p.id)
              .map((m) => (
                <Badge key={m.id} tone="muted">
                  {m.label}
                </Badge>
              ))}
            <AddModel providerId={p.id} onDone={() => router.refresh()} />
          </div>
        </Card>
      ))}
    </div>
  );
}

function AddModel({ providerId, onDone }: { providerId: string; onDone: () => void }) {
  const [modelId, setModelId] = useState("");
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center gap-1">
      <input
        value={modelId}
        onChange={(e) => setModelId(e.target.value)}
        placeholder="model id (e.g. gpt-4o)"
        className="num w-40 rounded border border-input bg-background px-2 py-1 text-xs outline-none"
      />
      <Button
        variant="ghost"
        onClick={() =>
          start(async () => {
            if (!modelId.trim()) return;
            await addModel({ providerId, modelId });
            setModelId("");
            onDone();
          })
        }
        disabled={pending}
      >
        + model
      </Button>
    </div>
  );
}
