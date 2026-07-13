import { createClient } from "@supabase/supabase-js";

/**
 * ⚠️ SERVICE-ROLE CLIENT — BYPASSES RLS (service_role carries BYPASSRLS; FORCE
 * RLS does NOT stop it). When this client runs, the trust boundary is no longer
 * Postgres — it is this code path. Therefore it is QUARANTINED:
 *
 *   - It may only be imported from src/app/api/v1/** (the capture proxy).
 *   - tests/admin-quarantine.test.ts fails the build on any other importer.
 *   - The proxy must resolve org_id ONLY from a hashed api_key (see the
 *     api_keys table), never from a caller-controlled header/body/query.
 *
 * If you are reaching for this outside the proxy, you are about to cross the
 * tenant boundary in application code. Don't.
 */
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
