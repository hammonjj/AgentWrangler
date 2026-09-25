/**
 * A small JSON Schema checker for structured completions (#30). Covers the
 * subset the assessor, planner and verifier schemas use: `type` (one or a
 * list), `enum`, `const`, `properties`, `required`, `additionalProperties`,
 * `items`, `minItems`/`maxItems`, `minLength`/`maxLength`,
 * `minimum`/`maximum`, `anyOf`. Other keywords are ignored, so a schema that
 * relies on them is checked less strictly, never more. No dependency.
 */

export type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  anyOf?: JsonSchema[];
  description?: string;
  [key: string]: unknown;
};

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  return actual === t || (t === 'number' && actual === 'integer');
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Every way `value` breaks `schema`, as `path: problem`. Empty means valid. */
export function validateJson(schema: JsonSchema, value: unknown, at = '$'): string[] {
  const errors: string[] = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      return [`${at}: expected ${types.join(' or ')}, got ${typeOf(value)}`];
    }
  }
  if (schema.enum && !schema.enum.some((e) => equal(e, value))) errors.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
  if ('const' in schema && !equal(schema.const, value)) errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.anyOf && !schema.anyOf.some((s) => validateJson(s, value, at).length === 0)) errors.push(`${at}: matches none of anyOf`);

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => errors.push(...validateJson(schema.items!, item, `${at}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) errors.push(`${at}: missing ${key}`);
    const props = schema.properties ?? {};
    for (const [key, v] of Object.entries(obj)) {
      if (props[key]) errors.push(...validateJson(props[key], v, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validateJson(schema.additionalProperties, v, `${at}.${key}`));
      }
    }
  }
  return errors;
}
