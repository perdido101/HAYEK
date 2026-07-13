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

  // 5) model registry: 3 providers -> mock, 4 models across capability tiers
  const enc = await encryptSecret("mock-provider-key");
  async function getOrCreateProvider(label, adapter) {
    let { data } = await admin.from("model_providers").select("id").eq("org_id", org.id).eq("label", label).maybeSingle();
    if (data) return data.id;
    ({ data } = await admin
      .from("model_providers")
      .insert({ org_id: org.id, label, adapter, base_url: MOCK, api_key_encrypted: enc })
      .select("id")
      .single());
    return data.id;
  }
  const pAnthropic = await getOrCreateProvider("Anthropic", "anthropic");
  const pOpenAI = await getOrCreateProvider("OpenAI", "openai");
  const pVllm = await getOrCreateProvider("Self-hosted (vLLM)", "openai_compatible");
  const modelDefs = [
    { model_id: "claude-strong", provider: pAnthropic, adapter: "anthropic" },
    { model_id: "gpt-strong", provider: pOpenAI, adapter: "openai" },
    { model_id: "oss-decent", provider: pVllm, adapter: "openai_compatible" },
    { model_id: "oss-weak-1b", provider: pVllm, adapter: "openai_compatible" },
  ];
  for (const m of modelDefs) {
    const { data: ex } = await admin
      .from("models")
      .select("id")
      .eq("provider_id", m.provider)
      .eq("model_id", m.model_id)
      .maybeSingle();
    if (!ex) await admin.from("models").insert({ org_id: org.id, provider_id: m.provider, model_id: m.model_id, label: m.model_id });
  }

  // 6) tasks + suites + evals + runs + policies (idempotent on the first task)
  const taskDefs = [
    { task: "capital-of-france", suite: "Capital", question: "What is the capital of France?", assertion: "PARIS", provenance: true },
    { task: "summarize-ticket", suite: "Summarize", question: "Summarize this support ticket.", assertion: "SUMMARY" },
    { task: "extract-json", suite: "Extract JSON", question: 'Return {"ok": true} as JSON.', assertion: '"ok"' },
  ];
  const { data: already } = await admin.from("tasks").select("id").eq("org_id", org.id).eq("name", "capital-of-france").maybeSingle();
  if (!already) {
    // fetch each model's answer from the mock once
    const answer = {};
    for (const m of modelDefs) {
      const res = await fetch(`${MOCK}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: m.model_id }),
      });
      const j = await res.json();
      answer[m.model_id] = j.choices[0].message.content;
    }
    const latency = { "claude-strong": 220, "gpt-strong": 210, "oss-decent": 150, "oss-weak-1b": 90 };
    const nowIso = new Date().toISOString();

    for (const td of taskDefs) {
      const { data: task } = await admin.from("tasks").insert({ org_id: org.id, name: td.task }).select("id").single();
      const { data: suite } = await admin.from("suites").insert({ org_id: org.id, name: td.suite, task_id: task.id }).select("id").single();

      let sourceCorrectionId = null;
      if (td.provenance) {
        const { data: trace } = await admin
          .from("traces")
          .insert({ org_id: org.id, model: "oss-weak-1b", prompt_messages: [{ role: "user", content: td.question }], output: "I'm not sure — maybe Lyon?", status_code: 200, tokens_in: 9, tokens_out: 6 })
          .select("id")
          .single();
        const { data: corr } = await admin
          .from("corrections")
          .insert({ org_id: org.id, trace_id: trace.id, corrected_output: "The capital of France is PARIS.", rating: 2, reason: "The model hedged instead of answering a simple factual question.", author: userId, status: "accepted" })
          .select("id")
          .single();
        sourceCorrectionId = corr.id;
      }

      const { data: ev } = await admin
        .from("evals")
        .insert({ org_id: org.id, suite_id: suite.id, name: td.question, input_messages: [{ role: "user", content: td.question }], expected_behavior: `Answer should contain ${td.assertion}`, assertions: [{ type: "contains", value: td.assertion }], tags: ["seed"], source_correction_id: sourceCorrectionId })
        .select("id")
        .single();

      for (const m of modelDefs) {
        const out = answer[m.model_id];
        const passed = out.includes(td.assertion);
        const { data: run } = await admin
          .from("runs")
          .insert({ org_id: org.id, suite_id: suite.id, model: m.model_id, adapter: m.adapter, started_at: nowIso, finished_at: nowIso, pass_rate: passed ? 1 : 0, cost: 0, price_table_version: "2026-01" })
          .select("id")
          .single();
        await admin.from("run_results").insert({
          run_id: run.id,
          org_id: org.id,
          eval_id: ev.id,
          passed,
          score: passed ? 1 : 0,
          output: out,
          latency_ms: latency[m.model_id],
          assertion_results: [{ type: "contains", passed, score: passed ? 1 : 0, reason: `${passed ? "contains" : "missing"} ${td.assertion}` }],
        });
      }

      await admin.from("route_policies").insert({
        org_id: org.id,
        task_id: task.id,
        candidates: modelDefs.map((m) => ({ model: m.model_id })),
        strategy: "cheapest_passing",
        min_pass_rate: 0.8,
        freshness_days: 30,
      });
    }
  }

  console.log("Seeded demo org 'Acme (demo)'.");
  console.log(`  login:  ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`  key:    ${DEMO_KEY}`);
  console.log(`  providers: Anthropic, OpenAI, Self-hosted (vLLM) -> ${MOCK}`);
  console.log(`  models: claude-strong, gpt-strong, oss-decent, oss-weak-1b`);
  console.log(`  3 tasks with suites/evals/runs + route policies (x-hayek-task ready)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
