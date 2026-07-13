/**
 * A small, dependency-free JSON Schema validator — the pragmatic subset an eval
 * actually needs: type, required, properties, items, enum. Not a spec-complete
 * validator; it answers "does this output have the shape we expect?" and says
 * why when it doesn't.
 */

type Schema = Record<string, unknown>;

export function validateJsonSchema(value: unknown, schema: Schema): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  check(value, schema, "$", errors);
  return { valid: errors.length === 0, errors };
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // object | string | number | boolean | undefined
}

function check(value: unknown, schema: Schema, path: string, errors: string[]): void {
  const expected = schema.type as string | string[] | undefined;
  if (expected !== undefined) {
    const actual = typeOf(value);
    const allowed = Array.isArray(expected) ? expected : [expected];
    // JSON has no "integer"; accept a whole number for it.
    const ok = allowed.some((t) => t === actual || (t === "integer" && actual === "number" && Number.isInteger(value)));
    if (!ok) {
      errors.push(`${path}: expected ${allowed.join("|")}, got ${actual}`);
      return; // type mismatch — deeper checks would be noise
    }
  }

  if (Array.isArray(schema.enum)) {
    const found = schema.enum.some((e) => e === value);
    if (!found) errors.push(`${path}: value not in enum`);
  }

  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    const required = (schema.required as string[] | undefined) ?? [];
    for (const key of required) {
      if (!(key in obj)) errors.push(`${path}.${key}: required`);
    }
    const props = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) check(obj[key], sub, `${path}.${key}`, errors);
    }
  }

  if (typeOf(value) === "array" && schema.items) {
    const items = schema.items as Schema;
    (value as unknown[]).forEach((el, i) => check(el, items, `${path}[${i}]`, errors));
  }
}
