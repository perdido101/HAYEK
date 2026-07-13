import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * GUARD (sacred rule): /src/core must be pure TypeScript — zero framework
 * imports, zero network. If any file under core reaches for next, react,
 * supabase, or a fetch/network primitive, this test fails and the build
 * stops. core depends on nothing.
 */

const CORE_DIR = fileURLToPath(new URL("../src/core", import.meta.url));

// Modules core is forbidden from importing. Matched against the import source
// string (the part in quotes), so we catch `react`, `react/foo`, etc.
const FORBIDDEN_MODULES = [
  "next",
  "react",
  "react-dom",
  "@supabase/supabase-js",
  "@supabase/ssr",
  "server-only",
  "client-only",
];

// Network primitives that must not appear as bare identifiers in core.
const FORBIDDEN_NETWORK = [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /from\s+["']node:(http|https|net|dgram)["']/];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function importSources(src: string): string[] {
  const sources: string[] = [];
  const patterns = [
    /import\s+(?:[\w*{}\n\s,]+)\s+from\s+["']([^"']+)["']/g,
    /import\s+["']([^"']+)["']/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
    /import\(\s*["']([^"']+)["']\s*\)/g,
    /export\s+(?:[\w*{}\n\s,]+)\s+from\s+["']([^"']+)["']/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) if (m[1]) sources.push(m[1]);
  }
  return sources;
}

function isForbidden(source: string): boolean {
  return FORBIDDEN_MODULES.some(
    (mod) => source === mod || source.startsWith(`${mod}/`),
  );
}

describe("core purity guard", () => {
  const files = walk(CORE_DIR);

  it("finds core source files to guard", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = relative(CORE_DIR, file);
    const src = readFileSync(file, "utf8");

    it(`core/${rel} imports no framework/network module`, () => {
      const bad = importSources(src).filter(isForbidden);
      expect(bad, `forbidden imports in core/${rel}: ${bad.join(", ")}`).toEqual([]);
    });

    it(`core/${rel} uses no network primitive`, () => {
      const hit = FORBIDDEN_NETWORK.find((re) => re.test(src));
      expect(hit, `network primitive ${hit} used in core/${rel}`).toBeUndefined();
    });
  }
});
