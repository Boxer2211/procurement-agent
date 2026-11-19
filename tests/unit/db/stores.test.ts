import { describe, expect, it } from "vitest";
import { MemoryDataStore, MemoryTraceStore } from "../../../src/db/memory.js";
import { loadBudgets, loadVendors } from "../../../src/db/referenceData.js";
import { matchVendor, normalizeVendorName, similarity } from "../../../src/db/stores.js";
import { DATA_DIR } from "../../helpers.js";

const vendors = loadVendors(DATA_DIR);

describe("vendor matching", () => {
  it("normalises legal suffixes, case and punctuation", () => {
    expect(normalizeVendorName("TechSupply, Inc.")).toBe("techsupply");
    expect(normalizeVendorName("QuickParts Ltd")).toBe("quickparts");
  });

  it("scores identical strings 1 and unrelated strings low", () => {
    expect(similarity("techsupply", "techsupply")).toBe(1);
    expect(similarity("techsupply", "brightagency")).toBeLessThan(0.3);
  });

  it.each([
    ["TechSupply", "TechSupply", 1],
    ["tech supply inc", "TechSupply", 1],
    ["Shady Corp", "ShadyCorp", 1],
    ["TechSuply", "TechSupply", undefined],
    ["DataLens", "DataLens Analytics", 1],
  ])("matches %j to %s", (query, expected, score) => {
    const m = matchVendor(vendors, query);
    expect(m?.vendor.name).toBe(expected);
    if (score !== undefined) expect(m?.score).toBe(score);
  });

  it.each(["Totally Unknown Vendor", "", "   ", "Tech"])("returns null for %j", (q) => {
    expect(matchVendor(vendors, q)).toBeNull();
  });
});

describe("MemoryDataStore", () => {
  const store = new MemoryDataStore(loadBudgets(DATA_DIR), vendors);

  it("finds a budget by department/category/period, case-insensitively", async () => {
    const b = await store.getBudget(" Engineering ", "hardware", "2026-Q4");
    expect(b).toMatchObject({ allocated: 40000, spent: 18000, committed: 3800 });
  });

  it("returns null for unknown budgets", async () => {
    expect(await store.getBudget("engineering", "hardware", "2025-Q1")).toBeNull();
    expect(await store.getBudget("legal", "hardware", "2026-Q4")).toBeNull();
  });

  it("finds vendors", async () => {
    expect((await store.findVendor("cloud nimbus"))?.status).toBe("approved");
    expect(await store.findVendor("Nobody")).toBeNull();
  });
});

describe("MemoryTraceStore", () => {
  it("stores a run lifecycle and returns steps ordered by seq", async () => {
    const s = new MemoryTraceStore();
    await s.startRun({
      runId: "r1",
      inputText: "x",
      promptVersion: "v1",
      agentModel: "a",
      verifierModel: "b",
    });
    const step = (seq: number) => ({
      seq,
      node: "n",
      kind: "info" as const,
      name: `s${seq}`,
      input: null,
      output: null,
      error: null,
      durationMs: 1,
      inputTokens: null,
      outputTokens: null,
      at: new Date().toISOString(),
    });
    await s.appendSteps("r1", [step(2), step(1)]);
    await s.finishRun("r1", {
      status: "completed",
      decision: "needs_info",
      durationMs: 10,
      inputTokens: 5,
      outputTokens: 6,
      result: { ok: true },
    });
    await s.saveHumanDecision("r1", { decision: "approved" });
    const run = await s.getRun("r1");
    expect(run).toMatchObject({
      status: "completed",
      decision: "needs_info",
      humanDecision: { decision: "approved" },
    });
    expect(run?.finishedAt).not.toBeNull();
    expect((await s.getSteps("r1")).map((x) => x.seq)).toEqual([1, 2]);
    expect(await s.getRun("missing")).toBeNull();
    await expect(s.finishRun("missing", run as never)).rejects.toThrow(/unknown run/);
  });
});
