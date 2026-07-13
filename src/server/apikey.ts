/**
 * HAYEK API key material. Keys are shown to the customer ONCE at creation; we
 * persist only sha256(key). The proxy hashes the presented key and matches a
 * non-revoked api_keys row — that hash is the only thing that resolves an org.
 *
 * Uses Web Crypto globals (crypto.subtle / getRandomValues), available in both
 * the Node and Edge runtimes — no `node:crypto` import.
 */

const KEY_PREFIX = "hyk_live_";

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface GeneratedKey {
  /** Plaintext — return to the customer once, never store. */
  key: string;
  /** sha256(key) — store this. */
  keyHash: string;
  /** First chars, for display/lookup. */
  prefix: string;
}

export async function generateApiKey(): Promise<GeneratedKey> {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const key = KEY_PREFIX + base64url(bytes);
  return { key, keyHash: await sha256Hex(key), prefix: key.slice(0, 16) };
}
