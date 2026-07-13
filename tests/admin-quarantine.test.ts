import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * GUARD: the service-role admin client (src/server/admin.ts) BYPASSES RLS. Once
 * it runs, the tenant boundary is application code, not Postgres. So it may be
 * imported ONLY from the capture proxy under src/app/api/v1/**. Any other
 * importer fails this test — same energy as the core purity guard.
 */

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

// Where the admin client is allowed to be used (relative to src/).
const ALLOWED_PREFIXES = ["app/api/v1/"];

// The admin module itself, relative to src/ (it may of course define itself).
const ADMIN_MODULE = "server/admin.ts";

// Import specifiers that resolve to the admin module.
function importsAdmin(source: string): boolean {
  return (
    source === "@/server/admin" ||
    source.endsWith("/server/admin") ||
    source.endsWith("server/admin") // relative like ../../server/admin
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
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

describe("admin client quarantine", () => {
  const files = walk(SRC_DIR)
    .map((f) => ({ abs: f, rel: relative(SRC_DIR, f).replaceAll("\\", "/") }))
    .filter(({ rel }) => rel !== ADMIN_MODULE); // the module may reference itself

  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const { abs, rel } of files) {
    const src = readFileSync(abs, "utf8");
    if (!importSources(src).some(importsAdmin)) continue;

    it(`src/${rel} imports the admin client only from within the proxy`, () => {
      const allowed = ALLOWED_PREFIXES.some((p) => rel.startsWith(p));
      expect(
        allowed,
        `src/${rel} imports the service-role admin client but is not under src/app/api/v1/** — this crosses the tenant boundary outside the proxy`,
      ).toBe(true);
    });
  }
});
