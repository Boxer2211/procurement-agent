/** Reusable scripted LLM responses for graph tests. */

import type { AgentDraft, PurchaseRequest } from "../../src/domain/schemas.js";
import type { LLMScript, ScriptedResponse } from "../../src/llm/fake.js";

export const LAPTOP_TEXT =
  "We need to purchase 5 laptops for the development team. Total budget is $7,500. The vendor is TechSupply. Can this purchase be approved?";

export const laptopExtraction: PurchaseRequest = {
  is_procurement_request: true,
  off_topic_reason: null,
  summary: "Purchase of 5 laptops for the development team from TechSupply",
  category: "hardware",
  items: [{ name: "laptop", quantity: 5, unit_price: null }],
  total_amount: 7500,
  currency: "USD",
  vendor: "TechSupply",
  department: "engineering",
  cost_center: null,
  justification: "for the development team",
  provided_documents: [],
  quotes_count: null,
};

export const laptopPlan = {
  checks: [],
  search_queries: ["three quotes threshold purchases above 5000", "developer laptop price cap"],
  rationale: "Hardware purchase above $5,000 from a named vendor.",
};

export const laptopToolRounds: ScriptedResponse[] = [
  {
    toolCalls: [
      {
        name: "search_policies",
        input: {
          query: "three quotes threshold purchases above 5000",
          category: "hardware",
          top_k: 5,
        },
      },
      { name: "get_budget", input: { department: "engineering", category: "hardware" } },
      { name: "check_vendor", input: { vendor_name: "TechSupply" } },
      {
        name: "get_approval_route",
        input: { amount: 7500, currency: "USD", category: "hardware" },
      },
    ],
  },
  {
    toolCalls: [
      {
        name: "get_required_documents",
        input: { category: "hardware", amount: 7500, currency: "USD", vendor_status: "approved" },
      },
    ],
  },
];

export const laptopDraft: AgentDraft = {
  decision: "needs_info",
  confidence: 0.82,
  checks: [
    {
      check_id: "budget",
      status: "pass",
      detail: "Remaining Q4 hardware budget is $18,200.",
      evidence: ["tool:get_budget#1"],
    },
    {
      check_id: "vendor",
      status: "pass",
      detail: "TechSupply is approved until 2027-03-31.",
      evidence: ["tool:check_vendor#1"],
    },
    {
      check_id: "quotes",
      status: "fail",
      detail: "Above $5,000 three quotes are required.",
      evidence: ["policy:PROC-001#4.2", "tool:get_approval_route#1"],
    },
  ],
  violations: [],
  missing_information: ["cost center", "3 vendor quotes"],
  recommendations: ["Attach three vendor quotes and the laptop specification."],
};

export const verifierOk = { verdict: "ok", unsupported_claims: [], notes: "Grounded." };

export function laptopScript(
  overrides: Partial<Record<"extract" | "plan" | "agent" | "verify", ScriptedResponse[]>> = {},
): LLMScript {
  return {
    extract: [{ json: laptopExtraction }],
    plan: [{ json: laptopPlan }],
    agent: [...laptopToolRounds, { json: laptopDraft }],
    verify: [{ json: verifierOk }],
    ...overrides,
  };
}

export const offTopicExtraction: PurchaseRequest = {
  ...laptopExtraction,
  is_procurement_request: false,
  off_topic_reason: "asks for a poem",
  summary: "Request to write a poem",
  category: "other",
  items: [],
  total_amount: null,
  vendor: null,
  department: null,
  justification: null,
};
