"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Input } from "@/components/ui";
import { saveCorrection } from "../actions";

export interface TraceListItem {
  id: string;
  model: string;
  preview: string;
  createdAt: string;
  corrected: boolean;
}

export interface SelectedTrace {
  id: string;
  model: string;
  promptMessages: { role: string; content: string }[];
  output: string;
}

export function Inbox({ traces, selected }: { traces: TraceListItem[]; selected: SelectedTrace | null }) {
  const router = useRouter();

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
      {/* trace list */}
      <Card className="h-[calc(100vh-8rem)] overflow-y-auto">
        <div className="border-b border-border px-3 py-2 text-xs tracking-wider text-muted-foreground">
          INBOX · {traces.length}
        </div>
        <ul>
          {traces.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => router.push(`/inbox?trace=${t.id}`)}
                className={`w-full border-b border-border/50 px-3 py-2 text-left hover:bg-muted/40 ${
                  selected?.id === t.id ? "bg-muted/60" : ""
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="num text-xs text-foreground">{t.model}</span>
                  {t.corrected && <Badge tone="pass">saved</Badge>}
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">{t.preview || "—"}</div>
              </button>
            </li>
          ))}
          {traces.length === 0 && (
            <li className="px-3 py-6 text-center text-xs text-muted-foreground">no traces yet</li>
          )}
        </ul>
      </Card>

      {/* editor */}
      {selected ? (
        <Editor key={selected.id} trace={selected} onSaved={() => router.refresh()} />
      ) : (
        <Card className="flex h-[calc(100vh-8rem)] items-center justify-center text-sm text-muted-foreground">
          select a trace to correct
        </Card>
      )}
    </div>
  );
}

function Editor({ trace, onSaved }: { trace: SelectedTrace; onSaved: () => void }) {
  const [draft, setDraft] = useState(trace.output);
  const [rating, setRating] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setDraft(trace.output);
    setRating(null);
    setReason("");
    setStatus("idle");
  }, [trace.id, trace.output]);

  function save() {
    startTransition(async () => {
      const res = await saveCorrection({
        traceId: trace.id,
        correctedOutput: draft,
        rating,
        reason: reason || null,
      });
      if ("error" in res) setStatus("error");
      else {
        setStatus("saved");
        onSaved();
      }
    });
  }

  // One keystroke to accept: ⌘/Ctrl+Enter saves. No modal, no confirm.
  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      save();
    }
  }

  const dirty = draft !== trace.output || rating !== null || reason !== "";

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-3" onKeyDown={onKeyDown}>
      <div className="flex items-center justify-between">
        <div className="num text-xs text-muted-foreground">
          {trace.model} · <span className="text-foreground">{trace.id.slice(0, 8)}</span>
        </div>
        <div className="flex items-center gap-3">
          {status === "saved" && <Badge tone="pass">correction saved</Badge>}
          {status === "error" && <Badge tone="fail">save failed</Badge>}
          <span className="hidden text-xs text-muted-foreground sm:inline">⌘↵ to save</span>
          <Button variant="pass" onClick={save} disabled={pending || !draft.trim()}>
            {pending ? "saving…" : "Save correction"}
          </Button>
        </div>
      </div>

      {/* side by side: original (read-only) | editable */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-2">
        <Card className="flex min-h-0 flex-col">
          <div className="border-b border-border px-3 py-1.5 text-xs tracking-wider text-muted-foreground">
            MODEL OUTPUT
          </div>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3 py-2 text-sm leading-relaxed text-muted-foreground">
            {trace.output || "—"}
          </pre>
        </Card>
        <Card className="flex min-h-0 flex-col border-ring">
          <div className="border-b border-border px-3 py-1.5 text-xs tracking-wider text-[hsl(var(--accent))]">
            YOUR CORRECTION
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-transparent px-3 py-2 text-sm leading-relaxed outline-none"
          />
        </Card>
      </div>

      {/* optional fields — never gate the save */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">rating</span>
          {[1, 2, 3, 4, 5].map((r) => (
            <button
              key={r}
              onClick={() => setRating(rating === r ? null : r)}
              className={`num h-6 w-6 rounded border text-xs ${
                rating === r ? "border-transparent bg-[hsl(var(--accent))] text-black" : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {r}
            </button>
          ))}
          <span className="text-xs text-muted-foreground/60">optional</span>
        </div>
        <div className="flex flex-1 items-center gap-2">
          <span className="text-xs text-muted-foreground">reason</span>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="why was the output wrong? (optional)"
            className="flex-1"
          />
        </div>
        {dirty && status === "idle" && <span className="text-xs text-muted-foreground">unsaved</span>}
      </div>
    </div>
  );
}
