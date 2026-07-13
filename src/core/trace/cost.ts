/**
 * Cost estimation — pure arithmetic over a price table. The proxy passes the
 * model id and token counts; core computes the estimate. Prices are per 1M
 * tokens (USD). Unknown models fall back to zero so capture never fails on a
 * pricing gap — the estimate is advisory, the Trace is the source of truth.
 */

export interface ModelPrice {
  /** USD per 1M input tokens. */
  in: number;
  /** USD per 1M output tokens. */
  out: number;
}

export const PRICE_TABLE: Record<string, ModelPrice> = {
  "claude-opus-4-8": { in: 15, out: 75 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-haiku-4-5-20251001": { in: 0.8, out: 4 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
};

export function estimateCost(
  model: string,
  tokensIn: number | null,
  tokensOut: number | null,
): number {
  const price = PRICE_TABLE[model];
  if (!price) return 0;
  const inCost = ((tokensIn ?? 0) / 1_000_000) * price.in;
  const outCost = ((tokensOut ?? 0) / 1_000_000) * price.out;
  return Number((inCost + outCost).toFixed(6));
}
