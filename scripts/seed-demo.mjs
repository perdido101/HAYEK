// Seed a demo org, a login user, an API key, and upstreams pointing at the mock
// upstream. Uses the service-role client (server-side, out-of-band setup — this
// is the sanctioned use of admin outside the request path). Idempotent-ish.
//
//   node scripts/seed-demo.mjs
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function envFromLocal() {
  const out = {};
  try {
    for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {}
  return out;
}

const env = { ...envFromLocal(), ...process.env };
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing (check .env.local)");

const MOCK = env.MOCK_URL || "http://127.0.0.1:8787";
const DEMO_EMAIL = "demo@hayek.test";
const DEMO_PASSWORD = "hayekdemo123";
const DEMO_KEY = "hyk_live_demokey_0000000000000000";

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

async function main() {
  // 1) demo login user
  let userId;
  const created = await admin.auth.admin.createUser({
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    email_confirm: true,
  });
  if (created.data?.user) userId = created.data.user.id;
  else {
    const { data } = await admin.auth.admin.listUsers();
    userId = data.users.find((u) => u.email === DEMO_EMAIL)?.id;
  }
  if (!userId) throw new Error("could not create/find demo user");

  // 2) org + owner membership (service role bypasses RLS for setup)
  let { data: org } = await admin.from("orgs").select("id").eq("name", "Acme (demo)").maybeSingle();
  if (!org) {
    ({ data: org } = await admin.from("orgs").insert({ name: "Acme (demo)" }).select("id").single());
  }
  await admin.from("org_members").upsert(
    { org_id: org.id, user_id: userId, role: "owner" },
    { onConflict: "org_id,user_id" },
  );

  // 3) API key (store only the hash)
  const keyHash = sha256(DEMO_KEY);
  const { data: existingKey } = await admin.from("api_keys").select("id").eq("key_hash", keyHash).maybeSingle();
  if (!existingKey) {
    await admin.from("api_keys").insert({
      org_id: org.id,
      key_hash: keyHash,
      prefix: DEMO_KEY.slice(0, 16),
      name: "demo",
    });
  }

  // 4) upstreams -> mock, one per protocol
  for (const provider of ["openai", "anthropic"]) {
    const { data: up } = await admin
      .from("upstreams")
      .select("id")
      .eq("org_id", org.id)
      .eq("provider", provider)
      .maybeSingle();
    if (!up) {
      await admin.from("upstreams").insert({
        org_id: org.id,
        provider,
        base_url: MOCK,
        api_key: "mock-upstream-key",
        is_default: true,
      });
    }
  }

  console.log("Seeded demo org 'Acme (demo)'.");
  console.log(`  login:  ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`  key:    ${DEMO_KEY}`);
  console.log(`  upstream -> ${MOCK}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
