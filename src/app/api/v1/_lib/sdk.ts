import { createAdminClient } from "@/server/admin";
import { resolveOrgId } from "./deps";

/** Pull the presented HAYEK key from either auth style. */
export function presentedKey(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.headers.get("x-api-key");
}

export async function orgFromRequest(req: Request): Promise<{ orgId: string; apiKeyId: string } | null> {
  const key = presentedKey(req);
  if (!key) return null;
  return resolveOrgId(key);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const asUuidOrNull = (v: unknown): string | null =>
  typeof v === "string" && UUID_RE.test(v) ? v : null;

export { createAdminClient };
