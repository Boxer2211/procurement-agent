/**
 * End-to-end: HTTP API -> LangGraph -> tools -> rules -> verifier -> JSON, with a scripted LLM
 * and in-memory storage. Each scenario's result must satisfy samples/expected/<slug>.json.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { ReviewResultSchema } from "../../src/domain/schemas.js";
import { matchExpected } from "../../src/evaluation/matchExpected.js";
import { createTestApp } from "../serviceHelpers.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));
const readInput = (slug: string) => {
  const { request, context } = readJson(`samples/inputs/${slug}.json`) as {
    request: string;
    context?: unknown;
  };
  return context === undefined ? { request } : { request, context };
};

const SCENARIOS = [
  "laptops_needs_info",
  "monitors_recommend_approve",
  "contractor_over_threshold",
  "blacklisted_vendor_reject",
  "split_purchase_violation",
  "prompt_injection_escalate",
  "off_topic_refused",
  "saas_security_review",
  "budget_exceeded_reject",
];

describe.each(SCENARIOS)("scenario %s", (slug) => {
  it("matches the expected outcome via the HTTP API", async () => {
    const input = readInput(slug);
    const expected = readJson(`samples/expected/${slug}.json`) as Record<string, unknown>;
    const app = await createTestApp(readJson(`tests/fixtures/llm-scripts/${slug}.json`) as never);
    const server = buildServer(app.service);

    const res = await server.inject({ method: "POST", url: "/v1/reviews", payload: input });
    expect(res.statusCode).toBe(200);
    const result = ReviewResultSchema.parse(res.json());
    expect(res.headers["x-run-id"]).toBe(result.run_id);
    expect(matchExpected(result, expected)).toEqual([]);

    const trace = await server.inject({ method: "GET", url: `/v1/runs/${result.run_id}/trace` });
    expect(trace.statusCode).toBe(200);
    const steps = trace.json().steps as { node: string; error: string | null }[];
    expect(steps[0]?.node).toBe("guard");
    expect(steps.at(-1)?.node).toBe("compose");

    // The full output doubles as documentation (docs/examples) and a regression snapshot.
    const normalized = JSON.stringify({ ...result, run_id: "<run_id>" }, null, 2);
    await expect(`${normalized}\n`).toMatchFileSnapshot(
      resolve(ROOT, `docs/examples/${slug}.json`),
    );
    await server.close();
  });
});

describe("HTTP API", () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let server: ReturnType<typeof buildServer>;
  beforeAll(async () => {
    app = await createTestApp(
      readJson("tests/fixtures/llm-scripts/laptops_needs_info.json") as never,
      {
        HUMAN_REVIEW: "true",
      },
    );
    server = buildServer(app.service);
  });
  afterAll(() => server.close());

  it("GET /healthz", async () => {
    expect((await server.inject({ method: "GET", url: "/healthz" })).json()).toEqual({
      status: "ok",
    });
  });

  it.each([
    [{}, "request"],
    [{ request: 42 }, "request"],
    [{ request: "x", extra: true }, ""],
    [
      { request: "buy", context: { providedDocuments: ["passport"] } },
      "context.providedDocuments.0",
    ],
  ])("POST /v1/reviews rejects %j with 400", async (payload, path) => {
    const res = await server.inject({ method: "POST", url: "/v1/reviews", payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    if (path) expect(res.json().issues.map((i: { path: string }) => i.path)).toContain(path);
  });

  it("returns 404 for unknown runs and 400 for malformed ids", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect((await server.inject({ method: "GET", url: `/v1/runs/${id}` })).statusCode).toBe(404);
    expect((await server.inject({ method: "GET", url: `/v1/runs/${id}/trace` })).statusCode).toBe(
      404,
    );
    expect((await server.inject({ method: "GET", url: "/v1/runs/not-a-uuid" })).statusCode).toBe(
      400,
    );
  });

  it("human-in-the-loop: review pauses, approver decides, second decision conflicts", async () => {
    const input = readInput("laptops_needs_info");
    const review = await server.inject({ method: "POST", url: "/v1/reviews", payload: input });
    expect(review.headers["x-awaiting-human-decision"]).toBe("true");
    const runId = review.json().run_id as string;

    const bad = await server.inject({
      method: "POST",
      url: `/v1/runs/${runId}/decision`,
      payload: { decision: "maybe" },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await server.inject({
      method: "POST",
      url: `/v1/runs/${runId}/decision`,
      payload: { decision: "request_info", approver: "dept.head", comment: "Please add quotes" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ decision: "request_info", approver: "dept.head" });

    const run = (await server.inject({ method: "GET", url: `/v1/runs/${runId}` })).json();
    expect(run).toMatchObject({
      status: "completed",
      decision: "needs_info",
      humanDecision: { decision: "request_info" },
    });

    const again = await server.inject({
      method: "POST",
      url: `/v1/runs/${runId}/decision`,
      payload: { decision: "approve", approver: "x", comment: null },
    });
    expect(again.statusCode).toBe(409);
  });
});
