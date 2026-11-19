/** Tool registry: definitions for the LLM, validated + time-boxed execution. */

import type { z } from "zod";
import { toStrictJsonSchema } from "../llm/jsonSchema.js";
import type { ToolDefinition } from "../llm/types.js";
import { getApprovalRouteTool } from "./approval.js";
import { getBudgetTool } from "./budget.js";
import { getRequiredDocumentsTool } from "./documents.js";
import { getPriceBenchmarkTool } from "./pricing.js";
import { searchPoliciesTool } from "./searchPolicies.js";
import { type ToolContext, type ToolDef, ToolError } from "./types.js";
import { checkVendorTool } from "./vendors.js";

export const defaultTools: readonly ToolDef[] = [
  searchPoliciesTool,
  getBudgetTool,
  checkVendorTool,
  getApprovalRouteTool,
  getRequiredDocumentsTool,
  getPriceBenchmarkTool,
] as readonly ToolDef[];

export type ToolExecution =
  | { ok: true; output: unknown; durationMs: number }
  | { ok: false; error: string; internalError: string | null; durationMs: number };

class ToolTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolTimeoutError(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
}

export class ToolRegistry {
  private readonly tools: Map<string, ToolDef>;

  constructor(
    tools: readonly ToolDef[],
    private readonly ctx: ToolContext,
  ) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
    if (this.tools.size !== tools.length) throw new Error("duplicate tool names");
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: toStrictJsonSchema(t.input),
      strict: true,
    }));
  }

  /** Never throws: every failure becomes an error result the agent (and the trace) can see. */
  async execute(name: string, rawInput: unknown): Promise<ToolExecution> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        error: `Unknown tool '${name}'.`,
        internalError: null,
        durationMs: elapsed(),
      };
    }
    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) {
      return {
        ok: false,
        error: `Invalid input for ${name}: ${formatZodError(parsed.error)}`,
        internalError: null,
        durationMs: elapsed(),
      };
    }
    try {
      const raw = await withTimeout(tool.run(parsed.data, this.ctx), tool.timeoutMs);
      const output = tool.output.parse(raw);
      return { ok: true, output, durationMs: elapsed() };
    } catch (err) {
      if (err instanceof ToolError) {
        return { ok: false, error: err.message, internalError: null, durationMs: elapsed() };
      }
      if (err instanceof ToolTimeoutError) {
        return {
          ok: false,
          error: `${name} ${err.message}.`,
          internalError: null,
          durationMs: elapsed(),
        };
      }
      return {
        ok: false,
        error: `${name} failed due to an internal error.`,
        internalError: err instanceof Error ? err.message : String(err),
        durationMs: elapsed(),
      };
    }
  }
}
