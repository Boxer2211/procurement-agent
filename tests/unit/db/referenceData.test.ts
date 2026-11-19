import { describe, expect, it } from "vitest";
import { loadBudgets, loadReferenceData, loadVendors } from "../../../src/db/referenceData.js";
import { DATA_DIR } from "../../helpers.js";

describe("reference data files", () => {
  const ref = loadReferenceData(DATA_DIR);

  it("loads the approval matrix sorted by threshold with an open-ended last level", () => {
    const maxes = ref.approvalMatrix.levels.map((l) => l.max_amount);
    expect(maxes).toEqual([1000, 5000, 25000, 100000, null]);
    expect(ref.approvalMatrix.fx_to_usd.USD).toBe(1);
  });

  it("loads required documents and the price catalog", () => {
    expect(ref.requiredDocs.map((d) => d.doc_id)).toContain("statement_of_work");
    expect(ref.catalog.find((c) => c.key === "developer laptop")).toMatchObject({
      min: 1100,
      max: 2000,
    });
  });

  it("loads budgets and vendors", () => {
    expect(loadBudgets(DATA_DIR).length).toBeGreaterThan(5);
    const vendors = loadVendors(DATA_DIR);
    expect(vendors.find((v) => v.name === "ShadyCorp")?.status).toBe("blacklisted");
  });
});
