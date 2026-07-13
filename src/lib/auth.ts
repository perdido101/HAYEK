import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export interface Membership {
  orgId: string;
  orgName: string;
  role: string;
}

/**
 * Resolve the signed-in user and their current org. Redirects to /login if not
 * authenticated, or /onboarding if the user has no org yet. Everything the app
 * reads afterward is RLS-scoped to this org automatically.
 */
export async function requireOrg(): Promise<{ userId: string; email: string; org: Membership }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: rows } = await supabase
    .from("org_members")
    .select("org_id, role, orgs(name)")
    .order("created_at", { ascending: true })
    .limit(1);

  const row = rows?.[0];
  if (!row) redirect("/onboarding");

  const orgs = row.orgs as unknown as { name: string } | null;
  return {
    userId: user.id,
    email: user.email ?? "",
    org: { orgId: row.org_id as string, orgName: orgs?.name ?? "org", role: row.role as string },
  };
}
