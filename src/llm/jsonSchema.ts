/**
 * zod -> JSON schema accepted by strict tool use / structured outputs.
 *
 * Strict mode does not support numeric / length / array-size constraints, so they are
 * stripped from the wire schema and appended to the description as a hint. zod still
 * enforces them locally when the tool input is parsed.
 */

import { z } from "zod";

type JsonSchema = { [key: string]: unknown };

const UNSUPPORTED = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "default",
] as const;

const SUPPORTED_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

function isObject(v: unknown): v is JsonSchema {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (!isObject(node)) return node;

  const out: JsonSchema = {};
  const hints: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema") continue;
    if ((UNSUPPORTED as readonly string[]).includes(key)) {
      if (key !== "default") hints.push(`${key}: ${JSON.stringify(value)}`);
      continue;
    }
    if (key === "format" && typeof value === "string" && !SUPPORTED_FORMATS.has(value)) {
      hints.push(`format: ${value}`);
      continue;
    }
    if (key === "properties" && isObject(value)) {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
      continue;
    }
    out[key] = clean(value);
  }

  if (out.type === "object") {
    out.additionalProperties = false;
    out.required = Object.keys(isObject(out.properties) ? out.properties : {});
  }
  if (hints.length > 0) {
    const base = typeof out.description === "string" ? `${out.description} ` : "";
    out.description = `${base}{${hints.join(", ")}}`;
  }
  return out;
}

export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  const raw = z.toJSONSchema(schema, { io: "input", unrepresentable: "throw" });
  const cleaned = clean(raw);
  if (!isObject(cleaned) || cleaned.type !== "object") {
    throw new Error("tool/output schemas must be objects");
  }
  return cleaned;
}
