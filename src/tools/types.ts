/** Tool contract: typed, read-only, bounded, traceable. */

import type { z } from "zod";
import type { ReferenceData } from "../db/referenceData.js";
import type { DataStore } from "../db/stores.js";
import type { PolicyIndex } from "../rag/store.js";

export interface ToolContext {
  data: DataStore;
  policies: PolicyIndex;
  ref: ReferenceData;
  budgetPeriod: string;
  /** ISO date (YYYY-MM-DD) used for contract expiry checks. */
  today: string;
}

/** Expected, user-safe failure (not found, unsupported input). Becomes `is_error` tool_result. */
export class ToolError extends Error {
  override name = "ToolError";
}

export interface ToolDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: I;
  output: O;
  timeoutMs: number;
  run(args: z.infer<I>, ctx: ToolContext): Promise<z.infer<O>>;
}

export function defineTool<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDef<I, O>,
): ToolDef<I, O> {
  if (!/^[a-z][a-z_]{2,40}$/.test(def.name)) throw new Error(`invalid tool name ${def.name}`);
  return def;
}
