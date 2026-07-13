/**
 * @hayek/sdk — a tiny client for the CAPTURE proxy. Two verbs:
 *
 *   wrapTrace()    run a model call and persist a Trace, transparently.
 *   logCorrection() attach a human correction to a Trace.
 *
 * The SDK does the network; it does not contain domain logic. It talks to a
 * HAYEK deployment's /v1 surface. Point `baseUrl` at your-hayek.app.
 */

export interface HayekClientOptions {
  /** Base URL of your HAYEK deployment, e.g. https://acme.hayek.app */
  baseUrl: string;
  /** Org-scoped API key issued by HAYEK. Sent as a bearer token. */
  apiKey: string;
  /** Injected for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface WrapTraceInput<T> {
  model: string;
  messages: Message[];
  taskId?: string;
  /** The actual model call. Its result is returned to you unchanged. */
  call: () => Promise<T>;
  /** Pull the completion text + token usage out of your provider's result. */
  extract: (result: T) => {
    output: string;
    tokensIn?: number;
    tokensOut?: number;
  };
}

export interface WrapTraceResult<T> {
  result: T;
  traceId: string;
}

export interface CorrectionInput {
  traceId: string;
  correctedOutput: string;
  rating: number;
  reason?: string;
  author?: string;
}

export class HayekClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HayekClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
    };
  }

  /**
   * Run `call`, measure it, and persist a Trace. Returns the provider result
   * unchanged plus the created traceId. A failure to log the trace never
   * masks your result — capture is best-effort and out of the hot path's way.
   */
  async wrapTrace<T>(input: WrapTraceInput<T>): Promise<WrapTraceResult<T>> {
    const startedAt = performance.now();
    const result = await input.call();
    const latencyMs = Math.round(performance.now() - startedAt);

    const { output, tokensIn, tokensOut } = input.extract(result);

    let traceId = "";
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/traces`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: input.model,
          task_id: input.taskId ?? null,
          prompt_messages: input.messages,
          output,
          latency_ms: latencyMs,
          tokens_in: tokensIn ?? null,
          tokens_out: tokensOut ?? null,
        }),
      });
      if (res.ok) {
        const body = (await res.json()) as { id?: string };
        traceId = body.id ?? "";
      }
    } catch {
      // best-effort capture; swallow so the caller's result is never lost.
    }

    return { result, traceId };
  }

  /** Attach a human correction to a trace. This is the gold. */
  async logCorrection(input: CorrectionInput): Promise<void> {
    await this.fetchImpl(`${this.baseUrl}/v1/traces/${input.traceId}/correction`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        corrected_output: input.correctedOutput,
        rating: input.rating,
        reason: input.reason ?? null,
        author: input.author ?? null,
      }),
    });
  }
}

/** Convenience factory. */
export function createHayekClient(opts: HayekClientOptions): HayekClient {
  return new HayekClient(opts);
}
