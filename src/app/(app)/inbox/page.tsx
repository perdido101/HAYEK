import { createClient } from "@/lib/supabase/server";
import { Inbox, type TraceListItem, type SelectedTrace } from "./inbox-client";

export const dynamic = "force-dynamic";

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ trace?: string }>;
}) {
  const { trace: selectedId } = await searchParams;
  const supabase = await createClient();

  const { data: rows } = await supabase
    .from("traces")
    .select("id, model, output, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  const traces = (rows ?? []) as { id: string; model: string; output: string | null; created_at: string }[];

  // Which traces already have a correction (to mark them done in the list).
  const { data: corr } = await supabase.from("corrections").select("trace_id");
  const corrected = new Set((corr ?? []).map((c) => c.trace_id as string));

  const list: TraceListItem[] = traces.map((t) => ({
    id: t.id,
    model: t.model,
    preview: (t.output ?? "").slice(0, 80),
    createdAt: t.created_at,
    corrected: corrected.has(t.id),
  }));

  const targetId = selectedId ?? list[0]?.id ?? null;
  let selected: SelectedTrace | null = null;
  if (targetId) {
    const { data: t } = await supabase
      .from("traces")
      .select("id, model, prompt_messages, output")
      .eq("id", targetId)
      .maybeSingle();
    if (t) {
      selected = {
        id: t.id as string,
        model: t.model as string,
        promptMessages: (t.prompt_messages ?? []) as { role: string; content: string }[],
        output: (t.output ?? "") as string,
      };
    }
  }

  return <Inbox traces={list} selected={selected} />;
}
