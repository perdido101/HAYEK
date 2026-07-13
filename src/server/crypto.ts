/**
 * Encryption for per-org provider secrets, at rest. AES-256-GCM with an
 * app-managed key (HAYEK_ENCRYPTION_KEY, 32 bytes base64). Server-only — the
 * key never reaches the browser, and ciphertext is stored in
 * model_providers.api_key_encrypted.
 *
 * Format: base64( iv[12] || ciphertext+tag ). Web Crypto (Node + Edge).
 */

function keyBytes(): Uint8Array {
  const b64 = process.env.HAYEK_ENCRYPTION_KEY;
  if (!b64) throw new Error("HAYEK_ENCRYPTION_KEY is not set");
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("HAYEK_ENCRYPTION_KEY must be 32 bytes (base64)");
  return raw;
}

async function importKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", keyBytes() as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await importKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(plaintext) as BufferSource,
    ),
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return toB64(packed);
}

export async function decryptSecret(packedB64: string): Promise<string> {
  const key = await importKey();
  const packed = Uint8Array.from(atob(packedB64), (c) => c.charCodeAt(0));
  const iv = packed.slice(0, 12);
  const ct = packed.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ct as BufferSource);
  return new TextDecoder().decode(pt);
}
