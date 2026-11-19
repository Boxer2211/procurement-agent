/** Dependencies injected into graph nodes, plus shared node helpers. */

import type { z } from "zod";
import type { Settings } from "../config.js";
import type { StepKind } from "../db/stores.js";
import {
  type ChatMessage,
  type LLMClient,
  LLMError,
  type LLMRequest,
  type LLMUsage,
} from "../llm/types.js";
import { maskPii } from "../observability/logger.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { NewStep } from "./state.js";

export type GraphSettings = Pick<
  Settings,
  | "AGENT_MODEL"
  | "VERIFIER_MODEL"
  | "AGENT_EFFORT"
  | "VERIFIER_EFFORT"
  | "MAX_ITERATIONS"
  | "MAX_REVISIONS"
  | "PROMPT_VERSION"
  | "MAX_INPUT_CHARS"
  | "HUMAN_REVIEW"
>;

export interface GraphDeps {
  llm: LLMClient;
  tools: ToolRegistry;
  settings: GraphSettings;
  /** Node retry backoff for transient LLM errors (ms). Small in tests. */
  retryInitialIntervalMs?: number;
}

export const DEPARTMENTS = [
  "engineering",
  "marketing",
  "sales",
  "operations",
  "finance",
  "hr",
  "legal",
] as const;

export function makeStep(
  node: string,
  kind: StepKind,
  name: string,
  fields: Partial<Omit<NewStep, "node" | "kind" | "name" | "at">> = {},
): NewStep {
  return {
    node,
    kind,
    name,
    input: fields.input ?? null,
    output: fields.output ?? null,
    error: fields.error ?? null,
    durationMs: fields.durationMs ?? 0,
    inputTokens: fields.inputTokens ?? null,
    outputTokens: fields.outputTokens ?? null,
    at: new Date().toISOString(),
  };
}

export const timer = () => {
  const start = performance.now();
  return () => Math.round(performance.now() - start);
};

/** Retryable LLM errors are rethrown so the node RetryPolicy can handle them. */
export function rethrowIfRetryable(err: unknown): void {
  if (err instanceof LLMError && err.retryable) throw err;
  if (!(err instanceof LLMError)) throw err;
}

export interface StructuredResult<T> {
  value: T | null;
  error: string | null;
  usage: LLMUsage;
  steps: NewStep[];
}

const MAX_STRUCTURED_ATTEMPTS = 2;

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  return JSON.parse(trimmed);
}

export function parseStructured<T>(
  schema: z.ZodType<T>,
  text: string,
): { ok: true; value: T } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = parseJson(text);
  } catch {
    return { ok: false, error: "output is not valid JSON" };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
        .join("; "),
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Single-shot structured call with one validation retry: the invalid output and the
 * validation error are fed back so the model can correct itself.
 */
export async function completeStructured<T>(
  llm: LLMClient,
  req: Omit<LLMRequest<T>, "outputSchema"> & { outputSchema: z.ZodType<T> },
): Promise<StructuredResult<T>> {
  const messages: ChatMessage[] = [...req.messages];
  const usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
  const steps: NewStep[] = [];
  let lastError = "no attempt";

  for (let attempt = 1; attempt <= MAX_STRUCTURED_ATTEMPTS; attempt++) {
    const elapsed = timer();
    const res = await llm.complete({ ...req, messages });
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    const parsed = parseStructured(req.outputSchema, res.text);
    steps.push(
      makeStep(req.node, "llm", `${req.node}.attempt${attempt}`, {
        input: { model: req.model, effort: req.effort },
        output: parsed.ok ? parsed.value : { raw: maskPii(res.text.slice(0, 2000)) },
        error: parsed.ok ? null : parsed.error,
        durationMs: elapsed(),
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
      }),
    );
    if (parsed.ok) return { value: parsed.value, error: null, usage, steps };
    lastError = parsed.error;
    messages.push(
      { role: "assistant", content: res.content },
      {
        role: "user",
        content: `Your previous output failed validation (${lastError}). Reply again with JSON that matches the schema exactly.`,
      },
    );
  }
  return { value: null, error: `invalid structured output: ${lastError}`, usage, steps };
}
