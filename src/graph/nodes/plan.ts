/** plan: deterministic baseline checks per category + LLM-proposed extra checks and search queries. */

import {
  type Category,
  type CheckId,
  CheckIdSchema,
  PlanOutputSchema,
  type PurchaseRequest,
  type ReviewPlan,
} from "../../domain/schemas.js";
import { loadPrompt, wrapJson } from "../../llm/prompting.js";
import { completeStructured, type GraphDeps, makeStep, rethrowIfRetryable } from "../deps.js";
import type { State, Update } from "../state.js";

const COMMON: CheckId[] = [
  "completeness",
  "budget",
  "vendor",
  "approval_route",
  "quotes",
  "documents",
  "justification",
  "policy_compliance",
];

export const BASELINE_CHECKS: Record<Category, CheckId[]> = {
  hardware: [...COMMON, "price"],
  software: [...COMMON, "price"],
  services: [...COMMON, "price"],
  other: COMMON,
};

const BASELINE_QUERIES: Record<Category, string[]> = {
  hardware: ["hardware standards laptop specification price cap", "competitive quotes threshold"],
  software: ["software SaaS security assessment licences", "competitive quotes threshold"],
  services: ["professional services statement of work NDA", "competitive quotes threshold"],
  other: ["purchase request mandatory fields", "competitive quotes threshold"],
};

export function baselinePlan(request: PurchaseRequest): ReviewPlan {
  return {
    checks: BASELINE_CHECKS[request.category],
    searchQueries: BASELINE_QUERIES[request.category],
    rationale: "Baseline checks for the request category.",
    source: "baseline",
  };
}

export function mergePlan(
  base: ReviewPlan,
  extraChecks: readonly CheckId[],
  queries: readonly string[],
  rationale: string,
): ReviewPlan {
  const cleanQueries = queries.map((q) => q.trim().slice(0, 200)).filter((q) => q.length >= 3);
  return {
    checks: [...new Set([...base.checks, ...extraChecks])],
    searchQueries: [...new Set(cleanQueries.length > 0 ? cleanQueries : base.searchQueries)].slice(
      0,
      5,
    ),
    rationale: rationale.slice(0, 500),
    source: "llm",
  };
}

export const makePlanNode =
  (deps: GraphDeps) =>
  async (state: State): Promise<Update> => {
    const request = state.request;
    if (!request) return { error: "plan: no request" };
    const base = baselinePlan(request);
    const system = loadPrompt("plan", deps.settings.PROMPT_VERSION, {
      check_ids: CheckIdSchema.options.join(", "),
    });
    const user = [
      wrapJson("purchase_request", request),
      wrapJson("baseline_checks", base.checks),
    ].join("\n\n");
    try {
      const res = await completeStructured(deps.llm, {
        node: "plan",
        model: deps.settings.AGENT_MODEL,
        effort: "low",
        maxTokens: 2000,
        system,
        messages: [{ role: "user", content: user }],
        outputSchema: PlanOutputSchema,
      });
      const plan = res.value
        ? mergePlan(base, res.value.checks, res.value.search_queries, res.value.rationale)
        : base;
      return {
        reviewPlan: plan,
        usage: res.usage,
        steps: [...res.steps, makeStep("plan", "info", "plan", { output: plan, error: res.error })],
      };
    } catch (err) {
      rethrowIfRetryable(err);
      // Planning is an optimisation: degrade to the deterministic baseline instead of failing.
      const message = err instanceof Error ? err.message : String(err);
      return {
        reviewPlan: base,
        steps: [
          makeStep("plan", "llm", "plan", {
            output: base,
            error: `fallback to baseline: ${message}`,
          }),
        ],
      };
    }
  };
