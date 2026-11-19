/** extract: LLM turns free text into a PurchaseRequest; code then normalises and cross-checks it. */

import { approxEqual, type Cents, fromCents, mulCents, toCents } from "../../domain/money.js";
import {
  type Flag,
  type PurchaseRequest,
  PurchaseRequestSchema,
  type RequestContext,
} from "../../domain/schemas.js";
import { loadPrompt, wrapJson, wrapUserRequest } from "../../llm/prompting.js";
import {
  completeStructured,
  DEPARTMENTS,
  type GraphDeps,
  makeStep,
  rethrowIfRetryable,
} from "../deps.js";
import type { State, Update } from "../state.js";

/** Sum of quantity × unit price when every item has both, else null. */
export function itemsTotal(request: PurchaseRequest): number | null {
  if (request.items.length === 0) return null;
  let sum = 0 as Cents;
  for (const item of request.items) {
    if (item.quantity === null || item.unit_price === null) return null;
    sum = (sum + mulCents(toCents(item.unit_price), item.quantity)) as Cents;
  }
  return fromCents(sum);
}

/** Deterministic post-processing: merge trusted context, normalise, compute and cross-check totals. */
export function normalizeRequest(
  request: PurchaseRequest,
  context: RequestContext | null,
): { request: PurchaseRequest; flags: Flag[] } {
  const flags: Flag[] = [];
  const out: PurchaseRequest = {
    ...request,
    currency: request.currency.trim().toUpperCase() || "USD",
    department: (context?.department ?? request.department)?.trim().toLowerCase() ?? null,
    cost_center: context?.costCenter ?? request.cost_center,
    provided_documents: [
      ...new Set([...request.provided_documents, ...(context?.providedDocuments ?? [])]),
    ],
    vendor: request.vendor?.trim() || null,
  };
  const computed = itemsTotal(out);
  if (out.total_amount === null && computed !== null) {
    out.total_amount = computed;
  } else if (out.total_amount !== null && computed !== null) {
    if (!approxEqual(toCents(out.total_amount), toCents(computed))) flags.push("amount_mismatch");
  }
  if (!out.is_procurement_request) flags.push("off_topic");
  return { request: out, flags };
}

export const makeExtractNode =
  (deps: GraphDeps) =>
  async (state: State): Promise<Update> => {
    const system = loadPrompt("extract", deps.settings.PROMPT_VERSION, {
      departments: DEPARTMENTS.join(", "),
    });
    const parts = [wrapUserRequest(state.text)];
    if (state.context) parts.push(wrapJson("request_context", state.context));
    try {
      const res = await completeStructured(deps.llm, {
        node: "extract",
        model: deps.settings.AGENT_MODEL,
        effort: "low",
        maxTokens: 4000,
        system,
        messages: [{ role: "user", content: parts.join("\n\n") }],
        outputSchema: PurchaseRequestSchema,
      });
      if (!res.value) {
        return { error: res.error, flags: ["llm_error"], usage: res.usage, steps: res.steps };
      }
      const { request, flags } = normalizeRequest(res.value, state.context);
      return {
        request,
        flags,
        usage: res.usage,
        steps: [
          ...res.steps,
          makeStep("extract", "rule", "normalize_request", { output: { request, flags } }),
        ],
      };
    } catch (err) {
      rethrowIfRetryable(err);
      const message = err instanceof Error ? err.message : String(err);
      return {
        error: `extract failed: ${message}`,
        flags: ["llm_error"],
        steps: [makeStep("extract", "llm", "extract", { error: message })],
      };
    }
  };

export const routeAfterExtract = (state: State): "plan" | "compose" =>
  !state.request || state.flags.includes("off_topic") ? "compose" : "plan";
