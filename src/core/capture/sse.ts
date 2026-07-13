/**
 * Generic Server-Sent Events framing. Provider-agnostic and pure: it turns a
 * raw SSE byte-stream (as text) into discrete events. Interpreting those events
 * into output text + token usage is provider-specific and lives in /src/adapters.
 *
 * We reassemble on OUR side after the client's stream has closed — the customer
 * gets tokens with zero added latency; this parser never sits in the hot path.
 */

export interface SSEEvent {
  event?: string;
  data: string;
}

/**
 * Parse a complete SSE payload into events. An event is a run of lines ended by
 * a blank line; `data:` lines within it are joined with "\n" per the spec, and
 * an `event:` line names it. Incomplete trailing events are included if they
 * carry data (upstreams don't always emit a final blank line).
 */
export function parseSSE(text: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  // Normalize CRLF, then split on blank lines separating events.
  const blocks = text.replace(/\r\n/g, "\n").split(/\n\n+/);

  for (const block of blocks) {
    if (!block.trim()) continue;
    let event: string | undefined;
    const dataLines: string[] = [];

    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue; // comment/heartbeat
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      // A single leading space after the colon is stripped, per spec.
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "event") event = value;
      else if (field === "data") dataLines.push(value);
    }

    if (dataLines.length > 0) events.push({ event, data: dataLines.join("\n") });
  }

  return events;
}

/** Safe JSON parse — capture must never throw on a malformed frame. */
export function tryParseJSON<T = unknown>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
