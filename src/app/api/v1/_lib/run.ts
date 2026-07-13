import { runSuite, type Eval, type JudgeFn, type ModelFn, type Suite } from "@/core";
import { anthropicAdapter, openaiAdapter, type ProviderAdapter } from "@/adapters";
import { createAdminClient } from "@/server/admin";
import { decryptSecret } from "@/server/crypto";

/**
 * The run executor. Given a suite + a set of registered models, it runs the
 * PURE core runner (runSuite) once per model and appends the evidence
 * (runs + run_results) via the service role — which is why this lives under
 * /v1, inside the admin quarantine.
 *
 * The model under test and the judge are real network calls built from the
 * org's registry: decrypt the provider key, build the request via the adapter,
 * POST it, parse the response. core never sees any of that.
 */

function adapterFor(kind: string): ProviderAdapter {
  return kind === "anthropic" ? anthropicAdapter : openaiAdapter; // openai + openai_compatible
}

interface ModelRow {
  id: string;
  model_id: string;
  adapter: string;
  base_url: string | null;
  api_key_encrypted: string;
}

/** Build a live ModelFn that calls a registered model non-streaming. */
async function makeModelFn(m: ModelRow): Promise<ModelFn> {
  const adapter = adapterFor(m.adapter);
  const baseUrl = (m.base_url ?? adapter.defaultBaseUrl).replace(/\/+$/, "");
  const key = await decryptSecret(m.api_key_encrypted);
  const auth = adapter.authHeader(key);

  return async (messages) => {
    const { path, body } = adapter.buildRequest(m.model_id, messages);
    const res = await fetch(baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json", [auth.name]: auth.value },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`upstream ${res.status}: ${text.slice(0, 160)}`);
    const ex = adapter.extractFromJson(text);
    return { output: ex.output, tokensIn: ex.tokensIn, tokensOut: ex.tokensOut };
  };
}

const noJudge: JudgeFn = async () => {
  throw new Error("no judge model configured for this run");
};

export interface RunRequest {
  orgId: string;
  suiteId: string;
  modelIds: string[];
  judgeModelId?: string | null;
}

/** Execute a suite against N models. Returns the created run ids. */
export async function executeRun(req: RunRequest): Promise<{ runIds: string[] } | { error: string }> {
  const admin = createAdminClient();

  // suite must belong to the caller's org
  const { data: suiteRow } = await admin
    .from("suites")
    .select("id, org_id, name")
    .eq("id", req.suiteId)
    .maybeSingle();
  if (!suiteRow || suiteRow.org_id !== req.orgId) return { error: "suite not found" };
  const suite: Suite = { id: suiteRow.id, name: suiteRow.name };

  const { data: evalRows } = await admin
    .from("evals")
    .select("id, name, input_messages, expected_behavior, assertions, tags")
    .eq("suite_id", suite.id)
    .eq("org_id", req.orgId);
  const evals: Eval[] = (evalRows ?? []).map((e) => ({
    id: e.id as string,
    name: e.name as string,
    input_messages: (e.input_messages ?? []) as Eval["input_messages"],
    expected_behavior: (e.expected_behavior as string | null) ?? null,
    assertions: (e.assertions ?? []) as Eval["assertions"],
    tags: (e.tags ?? []) as string[],
  }));
  if (evals.length === 0) return { error: "suite has no evals" };

  const { data: modelRows } = await admin
    .from("models")
    .select("id, model_id, model_providers(adapter, base_url, api_key_encrypted)")
    .in("id", req.modelIds)
    .eq("org_id", req.orgId);
  const models = (modelRows ?? []).map((m) => {
    const p = m.model_providers as unknown as { adapter: string; base_url: string | null; api_key_encrypted: string };
    return { id: m.id as string, model_id: m.model_id as string, ...p } as ModelRow;
  });
  if (models.length === 0) return { error: "no valid models" };

  // optional judge
  let judgeFn: JudgeFn = noJudge;
  if (req.judgeModelId) {
    const jm = models.find((m) => m.id === req.judgeModelId);
    if (jm) {
      const jf = await makeModelFn(jm);
      judgeFn = async (messages) => (await jf(messages)).output;
    }
  }

  const runIds: string[] = [];
  for (const m of models) {
    const startedAt = new Date().toISOString();
    let report;
    try {
      const modelFn = await makeModelFn(m);
      report = await runSuite(suite, evals, m.model_id, modelFn, judgeFn);
    } catch (e) {
      // whole-model failure (e.g. bad credentials) — record a zero run so the
      // column still shows up red rather than vanishing.
      report = {
        suite_id: suite.id,
        model: m.model_id,
        pass_rate: 0,
        cost: 0,
        price_table_version: "",
        per_eval_results: evals.map((ev) => ({
          eval_id: ev.id,
          passed: false,
          score: 0,
          output: "",
          assertion_results: [],
          latency_ms: null,
          error: String(e instanceof Error ? e.message : e),
        })),
      };
    }
    const finishedAt = new Date().toISOString();

    const { data: run } = await admin
      .from("runs")
      .insert({
        org_id: req.orgId,
        suite_id: suite.id,
        model: m.model_id,
        adapter: m.adapter,
        started_at: startedAt,
        finished_at: finishedAt,
        pass_rate: report.pass_rate,
        cost: report.cost,
        price_table_version: report.price_table_version || null,
      })
      .select("id")
      .single();
    if (!run) continue;

    const rows = report.per_eval_results.map((r) => ({
      run_id: run.id,
      org_id: req.orgId,
      eval_id: r.eval_id,
      passed: r.passed,
      score: r.score,
      output: r.output,
      assertion_results: r.assertion_results,
      latency_ms: r.latency_ms,
      error: r.error,
    }));
    if (rows.length) await admin.from("run_results").insert(rows);
    runIds.push(run.id as string);
  }

  return { runIds };
}
