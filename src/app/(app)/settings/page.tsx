import { createClient } from "@/lib/supabase/server";
import { Badge, Card } from "@/components/ui";
import { KeyManager } from "./key-manager";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: keys } = await supabase
    .from("api_keys")
    .select("id, name, prefix, last_used_at, revoked_at, created_at")
    .order("created_at", { ascending: false });
  const { data: upstreams } = await supabase
    .from("upstreams_public")
    .select("id, provider, base_url, is_default");

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">API keys</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Point your Anthropic/OpenAI SDK's base URL at{" "}
            <code className="num text-foreground">/v1</code> and use one of these as the key.
          </p>
        </div>
        <KeyManager
          keys={(keys ?? []).map((k) => ({
            id: k.id as string,
            name: k.name as string,
            prefix: k.prefix as string,
            lastUsedAt: k.last_used_at as string | null,
            revokedAt: k.revoked_at as string | null,
          }))}
        />
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Upstreams</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Where the proxy forwards. The provider secret is stored server-side and never shown here.
          </p>
        </div>
        <Card className="divide-y divide-border">
          {(upstreams ?? []).length === 0 && (
            <div className="px-4 py-4 text-sm text-muted-foreground">
              No upstream configured. Seed one with{" "}
              <code className="num text-foreground">node scripts/seed-demo.mjs</code>.
            </div>
          )}
          {(upstreams ?? []).map((u) => (
            <div key={u.id as string} className="flex items-center justify-between px-4 py-3 text-sm">
              <div className="num">
                {u.provider as string}
                <span className="ml-2 text-muted-foreground">{(u.base_url as string) ?? "(default)"}</span>
              </div>
              {(u.is_default as boolean) && <Badge tone="pass">default</Badge>}
            </div>
          ))}
        </Card>
      </section>
    </div>
  );
}
