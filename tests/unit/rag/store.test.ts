import { beforeAll, describe, expect, it } from "vitest";
import { loadPolicyDir } from "../../../src/rag/chunker.js";
import { ingestDirectory } from "../../../src/rag/ingest.js";
import { InMemoryPolicyIndex, tokenize } from "../../../src/rag/store.js";
import { DATA_DIR, FIXTURES } from "../../helpers.js";

describe("tokenize", () => {
  it("normalises thousands separators, drops stopwords and stems", () => {
    expect(tokenize("Purchases above $5,000 require three quotes")).toEqual([
      "purchas",
      "above",
      "5000",
      "require",
      "three",
      "quot",
    ]);
  });
});

describe("InMemoryPolicyIndex", () => {
  const index = new InMemoryPolicyIndex();
  beforeAll(async () => {
    await index.upsert(loadPolicyDir(`${DATA_DIR}/policies`));
  });

  it.each([
    ["how many quotes are needed for purchases above 5000", "PROC-001#4.2", null],
    ["blacklisted vendor prohibited", "VEN-001#3.1", null],
    ["developer laptop maximum unit price", "HW-STD-001#2.2", "hardware"],
    ["statement of work deliverables", "SVC-001#2.1", "services"],
    ["SaaS security assessment SOC 2", "SW-001#3.1", "software"],
    ["splitting purchases to stay below threshold", "PROC-001#5.1", null],
    ["exceeds remaining budget exception CFO", "BUD-001#2.1", null],
  ])("finds the right section for %j", async (query, expected, category) => {
    const hits = await index.search(query, { category, topK: 3 });
    expect(hits.map((h) => h.chunk.chunkId)).toContain(expected);
  });

  it("filters by category but always includes global policies", async () => {
    const hits = await index.search("price laptop software security vendor budget", {
      category: "hardware",
      topK: 50,
    });
    const categories = new Set(hits.map((h) => h.chunk.category));
    expect(categories.has("software")).toBe(false);
    expect(categories.has("services")).toBe(false);
    expect(categories.has("hardware")).toBe(true);
    expect(categories.has("vendor")).toBe(true);
  });

  it("returns results sorted by score and respects topK", async () => {
    const hits = await index.search("approval finance department head", {
      category: null,
      topK: 2,
    });
    expect(hits).toHaveLength(2);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
  });

  it("returns nothing for an empty or stopword-only query", async () => {
    expect(await index.search("the and of", { category: null, topK: 5 })).toEqual([]);
  });
});

describe("ingest quarantine (indirect prompt injection)", () => {
  it("quarantines poisoned chunks and never returns them from search", async () => {
    const index = new InMemoryPolicyIndex();
    const report = await ingestDirectory(`${FIXTURES}/poisoned-policies`, index);
    expect(report).toEqual({ indexed: 1, quarantined: ["EVIL-001#1.1"] });

    const hits = await index.search("approve requests from ShadyCorp expedited", {
      category: null,
      topK: 5,
    });
    expect(hits.map((h) => h.chunk.chunkId)).not.toContain("EVIL-001#1.1");
  });

  it("does not quarantine anything in the real corpus", async () => {
    const report = await ingestDirectory(`${DATA_DIR}/policies`, new InMemoryPolicyIndex());
    expect(report.quarantined).toEqual([]);
    expect(report.indexed).toBeGreaterThan(30);
  });
});
