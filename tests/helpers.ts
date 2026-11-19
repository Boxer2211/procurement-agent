import { resolve } from "node:path";
import { MemoryDataStore } from "../src/db/memory.js";
import { loadBudgets, loadReferenceData, loadVendors } from "../src/db/referenceData.js";
import type { PurchaseRequest } from "../src/domain/schemas.js";
import { loadPolicyDir } from "../src/rag/chunker.js";
import { InMemoryPolicyIndex } from "../src/rag/store.js";
import type { ToolContext } from "../src/tools/types.js";

export const DATA_DIR = resolve(import.meta.dirname, "..", "data");
export const FIXTURES = resolve(import.meta.dirname, "fixtures");

export async function createToolContext(
  overrides: Partial<ToolContext> = {},
): Promise<ToolContext> {
  const policies = new InMemoryPolicyIndex();
  await policies.upsert(loadPolicyDir(`${DATA_DIR}/policies`));
  return {
    data: new MemoryDataStore(loadBudgets(DATA_DIR), loadVendors(DATA_DIR)),
    policies,
    ref: loadReferenceData(DATA_DIR),
    budgetPeriod: "2026-Q4",
    today: "2026-11-19",
    ...overrides,
  };
}

export function makeRequest(overrides: Partial<PurchaseRequest> = {}): PurchaseRequest {
  return {
    is_procurement_request: true,
    off_topic_reason: null,
    summary: "5 developer laptops from TechSupply",
    category: "hardware",
    items: [{ name: "developer laptop", quantity: 5, unit_price: 1500 }],
    total_amount: 7500,
    currency: "USD",
    vendor: "TechSupply",
    department: "engineering",
    cost_center: "ENG-001",
    justification:
      "Five new backend engineers start on Dec 1 and have no laptops; without them onboarding slips.",
    provided_documents: ["hardware_specification"],
    quotes_count: 3,
    ...overrides,
  };
}
