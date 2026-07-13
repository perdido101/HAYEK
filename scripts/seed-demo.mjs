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

// AES-256-GCM, same format as src/server/crypto.ts: base64(iv[12] || ct)
async function encryptSecret(plain) {
  const raw = Buffer.from(env.HAYEK_ENCRYPTION_KEY, "base64");
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return Buffer.from(packed).toString("base64");
}

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

  // 5) model registry: one provider (openai wire -> mock) + two models
  let { data: provider } = await admin
    .from("model_providers")
    .select("id")
    .eq("org_id", org.id)
    .eq("label", "Mock (demo)")
    .maybeSingle();
  if (!provider) {
    ({ data: provider } = await admin
      .from("model_providers")
      .insert({
        org_id: org.id,
        label: "Mock (demo)",
        adapter: "openai",
        base_url: MOCK,
        api_key_encrypted: await encryptSecret("mock-provider-key"),
      })
      .select("id")
      .single());
  }
  for (const m of ["mock-gpt", "mock-weak-1b"]) {
    const { data: exists } = await admin
      .from("models")
      .select("id")
      .eq("provider_id", provider.id)
      .eq("model_id", m)
      .maybeSingle();
    if (!exists) await admin.from("models").insert({ org_id: org.id, provider_id: provider.id, model_id: m, label: m });
  }

  // 6) provenance chain: a trace, a human correction, an eval promoted from it
  const { data: existingEval } = await admin
    .from("evals")
    .select("id")
    .eq("org_id", org.id)
    .eq("name", "What is the capital of France?")
    .maybeSingle();
  if (!existingEval) {
    const { data: trace } = await admin
      .from("traces")
      .insert({
        org_id: org.id,
        model: "mock-weak-1b",
        prompt_messages: [{ role: "user", content: "What is the capital of France?" }],
        output: "I'm not sure — maybe Lyon?",
        status_code: 200,
        tokens_in: 9,
        tokens_out: 6,
      })
      .select("id")
      .single();
    const { data: correction } = await admin
      .from("corrections")
      .insert({
        org_id: org.id,
        trace_id: trace.id,
        corrected_output: "The capital of France is Paris.",
        rating: 2,
        reason: "The model hedged instead of answering a simple factual question.",
        author: userId,
        status: "accepted",
      })
      .select("id")
      .single();
    const { data: suite } = await admin
      .from("suites")
      .insert({ org_id: org.id, name: "Geography" })
      .select("id")
      .single();
    await admin.from("evals").insert({
      org_id: org.id,
      suite_id: suite.id,
      name: "What is the capital of France?",
      input_messages: [{ role: "user", content: "What is the capital of France?" }],
      expected_behavior: "Answer with the correct capital, Paris.",
      assertions: [{ type: "contains", value: "Paris" }],
      tags: ["promoted"],
      source_correction_id: correction.id,
    });
  }

  console.log("Seeded demo org 'Acme (demo)'.");
  console.log(`  login:  ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`  key:    ${DEMO_KEY}`);
  console.log(`  upstream -> ${MOCK}`);
  console.log(`  models: mock-gpt (answers), mock-weak-1b (hedges) -> ${MOCK}`);
  console.log(`  suite 'Geography' with 1 eval promoted from a correction`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
