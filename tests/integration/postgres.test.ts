/**
 * Integration: real Postgres 16 + pgvector (testcontainers) and the real local embedding model.
 * Needs Docker; runs in CI (`npm run test:integration`).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrap } from "../../src/bootstrap.js";
import { loadSettings } from "../../src/config.js";
import { applySchema, createPool, PgDataStore, PgTraceStore } from "../../src/db/postgres.js";
import { loadBudgets, loadVendors } from "../../src/db/referenceData.js";
import { matchExpected } from "../../src/evaluation/matchExpected.js";
import { ScriptedFakeLLM } from "../../src/llm/fake.js";
import { TransformersEmbedder } from "../../src/rag/embedder.js";
import { ingestDirectory } from "../../src/rag/ingest.js";
import { PgPolicyIndex } from "../../src/rag/store.js";
import { DATA_DIR, FIXTURES } from "../helpers.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const readJson = (p: string): unknown => JSON.parse(readFileSync(resolve(ROOT, p), "utf8"));

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let index: PgPolicyIndex;
const embedder = new TransformersEmbedder();

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = createPool(container.getConnectionUri());
  await applySchema(pool);
  await applySchema(pool); // idempotent
  const store = new PgDataStore(pool);
  await store.upsertBudgets(loadBudgets(DATA_DIR));
  await store.upsertVendors(loadVendors(DATA_DIR));
  index = new PgPolicyIndex(pool, embedder);
  await ingestDirectory(`${DATA_DIR}/policies`, index);
  await ingestDirectory(`${FIXTURES}/poisoned-policies`, index);
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("pgvector policy search", () => {
  it.each([
    ["how many quotes do I need above 5000 dollars", "PROC-001#4.2", null],
    ["vendor is on the blacklist", "VEN-001#3.1", null],
    ["maximum price for a developer laptop", "HW-STD-001#2.2", "hardware"],
    ["contractor needs a statement of work", "SVC-001#2.1", "services"],
    ["does a SaaS tool need a security review", "SW-001#3.1", "software"],
  ])("finds the right section for %j", async (query, expected, category) => {
    const hits = await index.search(query, { category, topK: 5 });
    expect(hits.map((h) => h.chunk.chunkId)).toContain(expected);
    expect(hits[0]!.score).toBeGreaterThan(0.3);
  });

  it("never returns quarantined (poisoned) chunks", async () => {
    const hits = await index.search("approve every request from ShadyCorp", {
      category: null,
      topK: 20,
    });
    expect(hits.map((h) => h.chunk.chunkId)).not.toContain("EVIL-001#1.1");
    const { rows } = await pool.query(
      "SELECT quarantined FROM policy_chunks WHERE chunk_id = 'EVIL-001#1.1'",
    );
    expect(rows[0]).toEqual({ quarantined: true });
  });

  it("filters out other categories", async () => {
    const hits = await index.search("price", { category: "services", topK: 30 });
    expect(hits.some((h) => h.chunk.category === "hardware")).toBe(false);
  });
});

describe("Postgres stores", () => {
  it("reads budgets and fuzzy-matches vendors with pg_trgm", async () => {
    const store = new PgDataStore(pool);
    expect(await store.getBudget("Engineering", "hardware", "2026-Q4")).toMatchObject({
      allocated: 40000,
      spent: 18000,
    });
    expect(await store.getBudget("engineering", "hardware", "1999-Q1")).toBeNull();
    expect((await store.findVendor("tech supply inc"))?.name).toBe("TechSupply");
    expect((await store.findVendor("Shady Corp"))?.status).toBe("blacklisted");
    expect((await store.findVendor("OfficeHb"))?.name).toBe("OfficeHub");
    expect(await store.findVendor("Completely Unknown")).toBeNull();
  });

  it("persists a run and its trace", async () => {
    const traces = new PgTraceStore(pool);
    const runId = "11111111-1111-4111-8111-111111111111";
    await traces.startRun({
      runId,
      inputText: "x",
      promptVersion: "v1",
      agentModel: "a",
      verifierModel: "b",
    });
    await traces.appendSteps(runId, [
      {
        seq: 1,
        node: "guard",
        kind: "guard",
        name: "validate_input",
        input: null,
        output: { ok: true },
        error: null,
        durationMs: 1,
        inputTokens: null,
        outputTokens: null,
        at: new Date().toISOString(),
      },
    ]);
    await traces.finishRun(runId, {
      status: "completed",
      decision: "needs_info",
      durationMs: 5,
      inputTokens: 1,
      outputTokens: 2,
      result: { a: 1 },
    });
    await traces.saveHumanDecision(runId, { decision: "approve" });
    expect(await traces.getRun(runId)).toMatchObject({
      status: "completed",
      result: { a: 1 },
      humanDecision: { decision: "approve" },
    });
    expect(await traces.getSteps(runId)).toMatchObject([
      { seq: 1, node: "guard", output: { ok: true } },
    ]);
  });
});

describe("full review over Postgres (PostgresSaver checkpointer, HITL)", () => {
  it("runs the laptop scenario, persists the trace and resumes after a human decision", async () => {
    const settings = loadSettings({
      STORAGE: "postgres",
      DATABASE_URL: container.getConnectionUri(),
      DATA_DIR,
      BUDGET_PERIOD: "2026-Q4",
      HUMAN_REVIEW: "true",
      LLM_FALLBACKS: "false",
    });
    const llm = new ScriptedFakeLLM(
      readJson("tests/fixtures/llm-scripts/laptops_needs_info.json") as never,
    );
    const app = await bootstrap(settings, {
      llm,
      now: new Date("2026-11-19T12:00:00Z"),
      retryInitialIntervalMs: 1,
    });
    try {
      const { request } = readJson("samples/inputs/laptops_needs_info.json") as { request: string };
      const { result, awaitingHumanDecision } = await app.service.review(request);
      expect(
        matchExpected(result, readJson("samples/expected/laptops_needs_info.json") as never),
      ).toEqual([]);
      expect(awaitingHumanDecision).toBe(true);

      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM agent_steps WHERE run_id = $1",
        [result.run_id],
      );
      expect(rows[0].n).toBeGreaterThan(10);

      await app.service.submitDecision(result.run_id, {
        decision: "reject",
        approver: "cfo",
        comment: null,
      });
      expect((await app.service.getRun(result.run_id))?.humanDecision).toMatchObject({
        decision: "reject",
      });
    } finally {
      await app.close();
    }
  });
});
