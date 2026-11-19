import { beforeAll, describe, expect, it } from "vitest";
import { loadReferenceData } from "../../../src/db/referenceData.js";
import { computeApprovalRoute, toUsd } from "../../../src/tools/approval.js";
import { computeRequiredDocuments } from "../../../src/tools/documents.js";
import { benchmarkPrice, matchCatalogItem } from "../../../src/tools/pricing.js";
import { defaultTools, ToolRegistry } from "../../../src/tools/registry.js";
import type { ToolContext } from "../../../src/tools/types.js";
import { createToolContext, DATA_DIR } from "../../helpers.js";

const ref = loadReferenceData(DATA_DIR);
const matrix = ref.approvalMatrix;

describe("computeApprovalRoute (PROC-002)", () => {
  it.each([
    [500, "hardware", ["line_manager", "it"], 1],
    [1000, "services", ["line_manager"], 1],
    [1000.01, "services", ["department_head"], 1],
    [5000, "hardware", ["department_head", "it"], 1],
    [5000.01, "hardware", ["department_head", "finance", "it"], 3],
    [7500, "hardware", ["department_head", "finance", "it"], 3],
    [24000, "services", ["department_head", "finance", "legal"], 3],
    [10000, "software", ["department_head", "finance", "it"], 3],
    [10000.5, "software", ["department_head", "finance", "it", "legal"], 3],
    [60000, "other", ["department_head", "finance", "cfo"], 3],
  ] as const)("%d %s -> %j, %d quotes", (amount, category, approvers, quotes) => {
    const r = computeApprovalRoute(amount, category, matrix);
    expect(r.approvers).toEqual(approvers);
    expect(r.min_quotes).toBe(quotes);
    expect(r.tender_required).toBe(false);
  });

  it("requires a tender above $100,000", () => {
    const r = computeApprovalRoute(150000, "services", matrix);
    expect(r.tender_required).toBe(true);
    expect(r.approvers).toContain("ceo");
    expect(r.rule_ids[0]).toBe("PROC-002#2.5");
  });

  it("converts currencies with reference rates and rejects unknown ones", () => {
    expect(toUsd(1000, "EUR", matrix)).toBe(1080);
    expect(toUsd(100, "usd", matrix)).toBe(100);
    expect(() => toUsd(100, "XYZ", matrix)).toThrow(/Unsupported currency/);
  });
});

describe("computeRequiredDocuments", () => {
  const ids = (
    category: Parameters<typeof computeRequiredDocuments>[0],
    amount: number | null,
    vendor: string | null,
  ) =>
    computeRequiredDocuments(category, amount, vendor, ref.requiredDocs).documents.map(
      (d) => d.doc_id,
    );

  it("hardware above $1,000 needs justification and a specification", () => {
    expect(ids("hardware", 7500, "approved")).toEqual([
      "business_justification",
      "cost_center",
      "vendor_quotes",
      "hardware_specification",
    ]);
  });

  it("small hardware purchases do not need a justification", () => {
    expect(ids("hardware", 900, "approved")).not.toContain("business_justification");
  });

  it("services above $10,000 need SOW, NDA and MSA", () => {
    expect(ids("services", 24000, "approved")).toEqual(
      expect.arrayContaining(["statement_of_work", "nda", "master_services_agreement"]),
    );
    expect(ids("services", 8000, "approved")).not.toContain("master_services_agreement");
  });

  it("software needs a security assessment and a user list", () => {
    expect(ids("software", 3000, "approved")).toEqual(
      expect.arrayContaining(["security_assessment", "license_user_list"]),
    );
  });

  it("unknown or pending vendors need onboarding", () => {
    expect(ids("hardware", 900, "unknown")).toContain("vendor_onboarding_form");
    expect(ids("hardware", 900, "pending")).toContain("vendor_onboarding_form");
    expect(ids("hardware", 900, "approved")).not.toContain("vendor_onboarding_form");
  });

  it("assumes the stricter case when the amount is unknown", () => {
    expect(ids("services", null, null)).toContain("master_services_agreement");
  });
});

describe("price benchmark", () => {
  it("prefers the most specific catalog entry", () => {
    expect(matchCatalogItem("Developer laptop 32GB", ref.catalog)?.key).toBe("developer laptop");
    expect(matchCatalogItem("laptops", ref.catalog)?.key).toBe("developer laptop");
    expect(matchCatalogItem("27-inch monitor", ref.catalog)?.key).toBe("monitor");
    expect(matchCatalogItem("espresso machine", ref.catalog)).toBeNull();
  });

  it.each([
    ["laptop", 1500, "within_range"],
    ["laptop", 2600, "above_range"],
    ["laptop", 300, "below_range"],
    ["espresso machine", 900, "no_benchmark"],
  ] as const)("%s at %d -> %s", (item, price, verdict) => {
    expect(benchmarkPrice(item, price, ref.catalog).verdict).toBe(verdict);
  });
});

describe("ToolRegistry", () => {
  let ctx: ToolContext;
  let registry: ToolRegistry;
  beforeAll(async () => {
    ctx = await createToolContext();
    registry = new ToolRegistry(defaultTools, ctx);
  });

  it("exposes strict tool definitions with closed schemas and no unsupported keywords", () => {
    const defs = registry.definitions();
    expect(defs.map((d) => d.name)).toEqual([
      "search_policies",
      "get_budget",
      "check_vendor",
      "get_approval_route",
      "get_required_documents",
      "get_price_benchmark",
    ]);
    for (const d of defs) {
      expect(d.strict).toBe(true);
      expect(d.input_schema).toMatchObject({ type: "object", additionalProperties: false });
      const json = JSON.stringify(d.input_schema);
      for (const kw of ["minimum", "maxLength", "minLength", "$schema", "exclusiveMinimum"]) {
        expect(json).not.toContain(`"${kw}"`);
      }
      const props = Object.keys(d.input_schema.properties as object);
      expect(d.input_schema.required).toEqual(props);
    }
  });

  it("rejects duplicate tool names", () => {
    expect(() => new ToolRegistry([defaultTools[0]!, defaultTools[0]!], ctx)).toThrow(/duplicate/);
  });

  it("search_policies returns citable evidence ids", async () => {
    const r = await registry.execute("search_policies", {
      query: "three quotes threshold",
      category: "hardware",
      top_k: 3,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const results = (r.output as { results: { evidence_id: string }[] }).results;
      expect(results.length).toBeLessThanOrEqual(3);
      expect(results.map((x) => x.evidence_id)).toContain("policy:PROC-001#4.2");
    }
  });

  it("get_budget computes remaining = allocated - spent - committed", async () => {
    const r = await registry.execute("get_budget", {
      department: "engineering",
      category: "hardware",
    });
    expect(r).toMatchObject({ ok: true, output: { remaining: 18200, period: "2026-Q4" } });
  });

  it("get_budget reports a user-safe error when no budget exists", async () => {
    const r = await registry.execute("get_budget", { department: "legal", category: "hardware" });
    expect(r).toMatchObject({ ok: false, internalError: null });
    if (!r.ok) expect(r.error).toMatch(/No hardware budget found for department 'legal'/);
  });

  it.each([
    ["TechSupply", "approved", "VEN-001#1.1"],
    ["Shady Corp", "blacklisted", "VEN-001#3.1"],
    ["DataLens", "pending", "VEN-001#2.1"],
    ["OldWare Systems", "expired", "VEN-001#1.2"],
    ["Unheard Of GmbH", "unknown", "VEN-001#2.1"],
  ])("check_vendor(%s) -> %s", async (name, status, ruleId) => {
    const r = await registry.execute("check_vendor", { vendor_name: name });
    expect(r).toMatchObject({ ok: true, output: { status, rule_id: ruleId } });
  });

  it("get_approval_route, get_required_documents and get_price_benchmark work end to end", async () => {
    expect(
      await registry.execute("get_approval_route", {
        amount: 7500,
        currency: "USD",
        category: "hardware",
      }),
    ).toMatchObject({
      ok: true,
      output: { min_quotes: 3 },
    });
    const docs = await registry.execute("get_required_documents", {
      category: "services",
      amount: 24000,
      currency: "USD",
      vendor_status: "approved",
    });
    expect(docs.ok).toBe(true);
    expect(
      await registry.execute("get_price_benchmark", {
        item: "laptop",
        unit_price: 1500,
        currency: "USD",
      }),
    ).toMatchObject({
      ok: true,
      output: { verdict: "within_range" },
    });
  });

  it.each([
    ["get_budget", { department: "", category: "hardware" }, /department/],
    ["get_budget", { department: "eng", category: "furniture" }, /category/],
    ["search_policies", { query: "x", category: null, top_k: 3 }, /query/],
    ["search_policies", { query: "quotes", category: null, top_k: 50 }, /top_k/],
    ["get_approval_route", { amount: -5, currency: "USD", category: "hardware" }, /amount/],
    ["check_vendor", { vendor_name: "TechSupply", extra: 1 }, /Invalid input/],
  ])("%s rejects invalid input %j", async (name, input, msg) => {
    const r = await registry.execute(name, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });

  it("reports unknown tools and unsupported currencies as errors", async () => {
    expect(await registry.execute("delete_everything", {})).toMatchObject({
      ok: false,
      error: "Unknown tool 'delete_everything'.",
    });
    const r = await registry.execute("get_approval_route", {
      amount: 5,
      currency: "XYZ",
      category: "hardware",
    });
    expect(r).toMatchObject({ ok: false, internalError: null });
  });

  it("hides internal errors from the model but keeps them for the trace", async () => {
    const broken = new ToolRegistry(defaultTools, {
      ...ctx,
      data: {
        getBudget: async () => {
          throw new Error("connection refused 10.0.0.5:5432");
        },
        findVendor: async () => null,
      },
    });
    const r = await broken.execute("get_budget", {
      department: "engineering",
      category: "hardware",
    });
    expect(r).toMatchObject({
      ok: false,
      error: "get_budget failed due to an internal error.",
      internalError: "connection refused 10.0.0.5:5432",
    });
  });

  it("times out slow tools", async () => {
    const slow = new ToolRegistry([{ ...defaultTools[2]!, timeoutMs: 20 }], {
      ...ctx,
      data: {
        getBudget: async () => null,
        findVendor: () => new Promise((r) => setTimeout(() => r(null), 500)),
      },
    });
    const r = await slow.execute("check_vendor", { vendor_name: "TechSupply" });
    expect(r).toMatchObject({ ok: false, error: "check_vendor timed out after 20 ms." });
  });
});
