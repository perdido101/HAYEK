/**
 * Cost estimation — pure arithmetic over a versioned price table. The proxy
 * passes the model id and token counts; core computes the estimate AND the
 * exact rates it used. Those rates are persisted on the Trace row so repricing
 * the table later never silently rewrites history (Phase 4 cost charts cite
 * traces as evidence — they must reproduce).
 *
 * Prices are per 1M tokens (USD). Unknown models fall back to zero so capture
 * never fails on a pricing gap — the estimate is advisory, the Trace is truth.
 */

export interface ModelPrice {
  /** USD per 1M input tokens. */
  in: number;
  /** USD per 1M output tokens. */
  out: number;
}

/**
 * Bump this whenever PRICE_TABLE changes. It is stamped onto every trace so a
 * cost can always be traced back to the exact table that produced it.
 */
export const PRICE_TABLE_VERSION = "2026-01";

export const PRICE_TABLE: Record<string, ModelPrice> = {
  "claude-opus-4-8": { in: 15, out: 75 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-haiku-4-5-20251001": { in: 0.8, out: 4 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
};

export interface TracePricing {
  /** Total estimated cost in USD. */
  cost_estimate: number;
  /** USD per 1M input tokens actually applied (null if model unknown). */
  rate_in: number | null;
  /** USD per 1M output tokens actually applied (null if model unknown). */
  rate_out: number | null;
  /** The price table version these rates came from. */
  price_table_version: string;
}

/**
 * Price a trace and return the rates used alongside the total, so the trace row
 * can store its own provenance. Unknown model → zero cost, null rates.
 */
export function priceTrace(
  model: string,
  tokensIn: number | null,
  tokensOut: number | null,
): TracePricing {
  const price = PRICE_TABLE[model];
  if (!price) {
    return {
      cost_estimate: 0,
      rate_in: null,
      rate_out: null,
      price_table_version: PRICE_TABLE_VERSION,
    };
  }
  const inCost = ((tokensIn ?? 0) / 1_000_000) * price.in;
  const outCost = ((tokensOut ?? 0) / 1_000_000) * price.out;
  return {
    cost_estimate: Number((inCost + outCost).toFixed(6)),
    rate_in: price.in,
    rate_out: price.out,
    price_table_version: PRICE_TABLE_VERSION,
  };
}

/** Convenience: just the total. Kept for call sites that only need the number. */
export function estimateCost(
  model: string,
  tokensIn: number | null,
  tokensOut: number | null,
): number {
  return priceTrace(model, tokensIn, tokensOut).cost_estimate;
}
