import { describe, expect, it } from "vitest";
import { loadReferenceData } from "../../../src/db/referenceData.js";
import { evaluateRules, type Facts } from "../../../src/rules/engine.js";
import { computeApprovalRoute } from "../../../src/tools/approval.js";
import { computeRequiredDocuments } from "../../../src/tools/documents.js";
import { benchmarkPrice } from "../../../src/tools/pricing.js";
import type { VendorOutput } from "../../../src/tools/vendors.js";
import { DATA_DIR, makeRequest } from "../../helpers.js";

const ref = loadReferenceData(DATA_DIR);

const approvedVendor: VendorOutput = {
  found: true,
  name: "TechSupply",
  status: "approved",
  categories: ["hardware"],
  contract_until: "2027-03-31",
  notes: null,
  rule_id: "VEN-001#1.1",
};

function facts(
  overrides: Partial<Facts> = {},
  amount = 7500,
  category: "hardware" | "services" | "software" = "hardware",
): Facts {
  return {
    amountUsd: amount,
    budget: {
      value: {
        department: "engineering",
        category,
        period: "2026-Q4",
        allocated: 40000,
        spent: 18000,
        committed: 3800,
        remaining: 18200,
        currency: "USD",
        rule_id: "BUD-001#1.1",
      },
      evidenceId: "tool:get_budget#1",
    },
    budgetError: null,
    vendor: { value: approvedVendor, evidenceId: "tool:check_vendor#1" },
    route: {
      value: computeApprovalRoute(amount, category, ref.approvalMatrix),
      evidenceId: "tool:get_approval_route#1",
    },
    documents: {
      value: computeRequiredDocuments(category, amount, "approved", ref.requiredDocs),
      evidenceId: "tool:get_required_documents#1",
    },
    prices: [
      {
        value: benchmarkPrice("developer laptop", 1500, ref.catalog),
        evidenceId: "tool:get_price_benchmark#1",
      },
    ],
    toolFailures: [],
    ...overrides,
  };
}

const statusOf = (outcome: ReturnType<typeof evaluateRules>, id: string) =>
  outcome.checks.find((c) => c.check_id === id)?.status;

describe("evaluateRules", () => {
  it("a complete, compliant request has a recommend_approve floor", () => {
    const o = evaluateRules(makeRequest(), facts(), []);
    expect(o.floor).toBe("recommend_approve");
    expect(o.violations).toEqual([]);
    expect(o.missing).toEqual([]);
    expect(o.checks.every((c) => c.status === "pass")).toBe(true);
    expect(o.checks.map((c) => c.check_id).sort()).toEqual(
      [
        "approval_route",
        "budget",
        "completeness",
        "documents",
        "justification",
        "price",
        "quotes",
        "vendor",
      ].sort(),
    );
  });

  it("the reference laptop request needs more info (quotes, cost center, justification)", () => {
    const req = makeRequest({
      cost_center: null,
      justification: "for the development team",
      provided_documents: [],
      quotes_count: null,
    });
    const o = evaluateRules(req, facts(), []);
    expect(o.floor).toBe("needs_info");
    expect(statusOf(o, "quotes")).toBe("fail");
    expect(statusOf(o, "justification")).toBe("warn");
    expect(statusOf(o, "documents")).toBe("fail");
    expect(statusOf(o, "budget")).toBe("pass");
    expect(statusOf(o, "vendor")).toBe("pass");
    expect(o.missing).toEqual(
      expect.arrayContaining([
        "cost center",
        "3 more vendor quote(s) (3 required, 0 provided)",
        "hardware_specification",
      ]),
    );
  });

  it("a blacklisted vendor forces recommend_reject with a cited violation", () => {
    const vendor = {
      value: {
        ...approvedVendor,
        name: "ShadyCorp",
        status: "blacklisted" as const,
        rule_id: "VEN-001#3.1",
      },
      evidenceId: "tool:check_vendor#1",
    };
    const o = evaluateRules(makeRequest({ vendor: "ShadyCorp" }), facts({ vendor }), []);
    expect(o.floor).toBe("recommend_reject");
    expect(o.violations[0]).toMatchObject({
      rule_id: "VEN-001#3.1",
      severity: "high",
      evidence: ["tool:check_vendor#1"],
    });
  });

  it("an exceeded budget forces recommend_reject", () => {
    const o = evaluateRules(
      makeRequest({
        total_amount: 20000,
        items: [{ name: "laptop", quantity: 10, unit_price: 2000 }],
      }),
      facts({}, 20000),
      [],
    );
    expect(o.floor).toBe("recommend_reject");
    expect(statusOf(o, "budget")).toBe("fail");
    expect(o.violations.map((v) => v.rule_id)).toContain("BUD-001#2.1");
  });

  it("budget equal to remaining passes (boundary)", () => {
    const o = evaluateRules(makeRequest({ total_amount: 18200 }), facts({}, 18200), []);
    expect(statusOf(o, "budget")).toBe("pass");
  });

  it.each([
    ["pending", "needs_info"],
    ["unknown", "needs_info"],
    ["expired", "needs_info"],
  ] as const)("a %s vendor forces %s", (status, floor) => {
    const vendor = { value: { ...approvedVendor, status }, evidenceId: "tool:check_vendor#1" };
    const o = evaluateRules(makeRequest(), facts({ vendor }), []);
    expect(o.floor).toBe(floor);
    expect(statusOf(o, "vendor")).toBe("fail");
  });

  it("a vendor approved for another category is a warning", () => {
    const o = evaluateRules(makeRequest({ category: "software" }), facts({}, 7500, "software"), []);
    expect(statusOf(o, "vendor")).toBe("warn");
    expect(o.floor).toBe("needs_info");
  });

  it.each([
    ["split_purchase_suspected", "recommend_reject", "PROC-001#5.1"],
    ["approval_bypass_attempt", "escalate_to_human", "PROC-001#5.2"],
  ] as const)("flag %s forces %s", (flag, floor, ruleId) => {
    const o = evaluateRules(makeRequest(), facts(), [flag]);
    expect(o.floor).toBe(floor);
    expect(o.violations.map((v) => v.rule_id)).toContain(ruleId);
  });

  it("suspected prompt injection escalates without inventing a violation", () => {
    const o = evaluateRules(makeRequest(), facts(), ["prompt_injection_suspected"]);
    expect(o.floor).toBe("escalate_to_human");
    expect(o.violations).toEqual([]);
    expect(o.hits.map((h) => h.ruleId)).toContain("GUARD-INJECTION");
  });

  it("flags never relax: injection + blacklisted vendor stays reject", () => {
    const vendor = {
      value: { ...approvedVendor, status: "blacklisted" as const },
      evidenceId: "tool:check_vendor#1",
    };
    const o = evaluateRules(makeRequest(), facts({ vendor }), ["prompt_injection_suspected"]);
    expect(o.floor).toBe("recommend_reject");
  });

  it("missing core fields need info", () => {
    const o = evaluateRules(
      makeRequest({ vendor: null, department: null, total_amount: null, items: [] }),
      facts({ vendor: null, budget: null, route: null, amountUsd: null }, 0),
      [],
    );
    expect(o.floor).toBe("needs_info");
    expect(o.missing).toEqual(
      expect.arrayContaining([
        "items to purchase",
        "total amount",
        "vendor",
        "requesting department",
      ]),
    );
    expect(statusOf(o, "budget")).toBe("unknown");
  });

  it("an unverifiable budget needs info and surfaces the reason", () => {
    const o = evaluateRules(
      makeRequest(),
      facts({ budget: null, budgetError: "No hardware budget found" }),
      [],
    );
    expect(o.floor).toBe("needs_info");
    expect(o.checks.find((c) => c.check_id === "budget")?.detail).toMatch(
      /No hardware budget found/,
    );
  });

  it("missing justification above $1,000 needs info; small purchases do not need one", () => {
    expect(
      statusOf(evaluateRules(makeRequest({ justification: null }), facts(), []), "justification"),
    ).toBe("fail");
    const small = makeRequest({
      justification: null,
      total_amount: 900,
      items: [{ name: "monitor", quantity: 2, unit_price: 450 }],
    });
    const o = evaluateRules(small, facts({}, 900), []);
    expect(statusOf(o, "justification")).toBeUndefined();
  });

  it("a price above a policy cap needs info; without a cap it only warns", () => {
    const capped = {
      value: benchmarkPrice("developer laptop", 2600, ref.catalog),
      evidenceId: "tool:get_price_benchmark#1",
    };
    const o = evaluateRules(makeRequest(), facts({ prices: [capped] }), []);
    expect(statusOf(o, "price")).toBe("fail");
    expect(o.floor).toBe("needs_info");

    const uncapped = {
      value: benchmarkPrice("docking station", 500, ref.catalog),
      evidenceId: "tool:get_price_benchmark#2",
    };
    const o2 = evaluateRules(makeRequest(), facts({ prices: [uncapped] }), []);
    expect(statusOf(o2, "price")).toBe("warn");
    expect(o2.floor).toBe("recommend_approve");
  });

  it("a tender is required above $100,000", () => {
    const o = evaluateRules(
      makeRequest({ total_amount: 150000 }),
      facts({ budget: null }, 150000),
      [],
    );
    expect(o.missing).toContain("formal tender (RFP) documentation");
  });

  it("amount mismatch and unsupported currency need info", () => {
    expect(evaluateRules(makeRequest(), facts(), ["amount_mismatch"]).floor).toBe("needs_info");
    const o = evaluateRules(
      makeRequest({ currency: "XYZ" }),
      facts({ amountUsd: null, budget: null, route: null }),
      [],
    );
    expect(o.missing).toContain("amount in a supported currency (got XYZ)");
  });

  it("internal tool failures raise a flag and need info", () => {
    const o = evaluateRules(
      makeRequest(),
      facts({ toolFailures: ["get_budget: connection refused"] }),
      [],
    );
    expect(o.flags).toContain("tool_failure");
    expect(o.floor).toBe("needs_info");
  });

  it("services require SOW and NDA", () => {
    const req = makeRequest({
      category: "services",
      vendor: "DevPartners",
      items: [{ name: "backend development", quantity: null, unit_price: null }],
      total_amount: 24000,
      provided_documents: [],
    });
    const vendor = {
      value: { ...approvedVendor, name: "DevPartners", categories: ["services"] },
      evidenceId: "tool:check_vendor#1",
    };
    const o = evaluateRules(req, facts({ vendor, prices: [] }, 24000, "services"), []);
    expect(o.missing).toEqual(
      expect.arrayContaining(["statement_of_work", "nda", "master_services_agreement"]),
    );
  });
});
