import { describe, expect, it } from "vitest";
import type { Check, ReviewResult } from "../../../src/domain/schemas.js";
import {
  mergeChecks,
  mergeMissing,
  mergeViolations,
  topicOf,
} from "../../../src/graph/nodes/compose.js";
import { itemsTotal, normalizeRequest } from "../../../src/graph/nodes/extract.js";
import { baselinePlan, mergePlan } from "../../../src/graph/nodes/plan.js";
import { renderSummary } from "../../../src/graph/nodes/summary.js";
import { nextEvidenceId } from "../../../src/graph/nodes/tools.js";
import { evidencePack, knownEvidence } from "../../../src/graph/nodes/verify.js";
import type { ToolCallRecord } from "../../../src/graph/state.js";
import { makeRequest } from "../../helpers.js";

describe("extract post-processing", () => {
  it("computes the total from items when not stated", () => {
    const { request, flags } = normalizeRequest(
      makeRequest({
        total_amount: null,
        items: [{ name: "monitor", quantity: 2, unit_price: 450.5 }],
      }),
      null,
    );
    expect(request.total_amount).toBe(901);
    expect(flags).toEqual([]);
  });

  it("flags a stated total that does not match the items", () => {
    const { flags } = normalizeRequest(makeRequest({ total_amount: 9000 }), null);
    expect(flags).toEqual(["amount_mismatch"]);
  });

  it("tolerates rounding (within 1%)", () => {
    expect(normalizeRequest(makeRequest({ total_amount: 7540 }), null).flags).toEqual([]);
  });

  it("merges trusted context and normalises fields", () => {
    const { request } = normalizeRequest(
      makeRequest({
        department: "Engineering ",
        currency: "usd",
        cost_center: null,
        provided_documents: ["nda"],
        vendor: "  ",
      }),
      {
        department: "Marketing",
        costCenter: "MKT-1",
        providedDocuments: ["statement_of_work", "nda"],
      },
    );
    expect(request).toMatchObject({
      department: "marketing",
      currency: "USD",
      cost_center: "MKT-1",
      vendor: null,
    });
    expect(request.provided_documents).toEqual(["nda", "statement_of_work"]);
  });

  it("flags off-topic requests", () => {
    expect(normalizeRequest(makeRequest({ is_procurement_request: false }), null).flags).toContain(
      "off_topic",
    );
  });

  it("returns null when any item lacks quantity or price", () => {
    expect(
      itemsTotal(makeRequest({ items: [{ name: "x", quantity: null, unit_price: 5 }] })),
    ).toBeNull();
    expect(itemsTotal(makeRequest({ items: [] }))).toBeNull();
  });
});

describe("plan", () => {
  it("baseline adds a price check for hardware", () => {
    expect(baselinePlan(makeRequest()).checks).toContain("price");
    expect(baselinePlan(makeRequest({ category: "other" })).checks).not.toContain("price");
  });

  it("merges LLM extras without duplicates and caps queries", () => {
    const base = baselinePlan(makeRequest());
    const plan = mergePlan(
      base,
      ["budget", "policy_compliance"],
      ["a", "q1 long enough", "q2 long enough", "q3 x", "q4 y", "q5 z", "q6 w"],
      "why",
    );
    expect(plan.checks.filter((c) => c === "budget")).toHaveLength(1);
    expect(plan.searchQueries).toHaveLength(5);
    expect(plan.searchQueries).not.toContain("a");
    expect(mergePlan(base, [], [], "").searchQueries).toEqual(base.searchQueries);
  });
});

describe("evidence helpers", () => {
  const calls: ToolCallRecord[] = [
    {
      evidenceId: "tool:search_policies#1",
      toolUseId: "t1",
      name: "search_policies",
      input: {},
      ok: true,
      output: { results: [{ evidence_id: "policy:PROC-001#4.2", heading: "h", text: "t" }] },
      error: null,
      internalError: null,
      initiator: "agent",
    },
    {
      evidenceId: "tool:get_approval_route#1",
      toolUseId: "t2",
      name: "get_approval_route",
      input: {},
      ok: true,
      output: { rule_ids: ["PROC-002#2.3"] },
      error: null,
      internalError: null,
      initiator: "agent",
    },
    {
      evidenceId: "tool:get_budget#1",
      toolUseId: "t3",
      name: "get_budget",
      input: {},
      ok: false,
      output: null,
      error: "nope",
      internalError: null,
      initiator: "agent",
    },
  ];

  it("numbers evidence per tool name", () => {
    expect(nextEvidenceId("get_budget", calls)).toBe("tool:get_budget#2");
    expect(nextEvidenceId("check_vendor", calls, 1)).toBe("tool:check_vendor#2");
  });

  it("collects known evidence ids including rule ids surfaced by tools, skipping failed calls", () => {
    const known = knownEvidence(calls);
    expect([...known].sort()).toEqual([
      "policy:PROC-001#4.2",
      "policy:PROC-002#2.3",
      "tool:get_approval_route#1",
      "tool:search_policies#1",
    ]);
  });

  it("builds an evidence pack keyed by evidence id", () => {
    const pack = evidencePack(calls);
    expect(Object.keys(pack).sort()).toEqual(["policy:PROC-001#4.2", "tool:get_approval_route#1"]);
  });
});

describe("compose helpers", () => {
  const c = (
    check_id: Check["check_id"],
    status: Check["status"],
    evidence: string[] = [],
  ): Check => ({ check_id, status, detail: status, evidence });

  it("deterministic checks win when at least as severe; evidence is merged", () => {
    const merged = mergeChecks(
      [c("budget", "pass", ["tool:a#1"]), c("vendor", "fail")],
      [c("budget", "fail", ["tool:b#1"]), c("vendor", "pass"), c("quotes", "warn")],
    );
    expect(merged).toEqual([
      { check_id: "budget", status: "fail", detail: "fail", evidence: ["tool:a#1", "tool:b#1"] },
      { check_id: "vendor", status: "fail", detail: "fail", evidence: [] },
      { check_id: "quotes", status: "warn", detail: "warn", evidence: [] },
    ]);
  });

  it("an 'unknown' rule check does not overwrite the model's assessment", () => {
    expect(mergeChecks([c("budget", "pass")], [c("budget", "unknown")])[0]!.status).toBe("pass");
  });

  it("violations are unioned by rule id", () => {
    const v = (rule_id: string) => ({
      rule_id,
      severity: "high" as const,
      detail: "",
      evidence: [],
    });
    expect(mergeViolations([v("A"), v("B")], [v("B"), v("C")]).map((x) => x.rule_id)).toEqual([
      "B",
      "C",
      "A",
    ]);
  });
});

describe("mergeMissing", () => {
  it("drops model paraphrases of items the rules already list", () => {
    const merged = mergeMissing(
      ["cost center", "3 more vendor quote(s) (3 required, 0 provided)", "hardware_specification"],
      [
        "Cost center",
        "2 additional vendor quotes",
        "laptop model/specification",
        "delivery address",
      ],
    );
    expect(merged).toEqual([
      "cost center",
      "3 more vendor quote(s) (3 required, 0 provided)",
      "hardware_specification",
      "delivery address",
    ]);
  });

  it("treats doc ids and their prose form as the same item", () => {
    expect(mergeMissing(["statement_of_work", "nda"], ["statement of work", "signed NDA"])).toEqual(
      ["statement_of_work", "nda"],
    );
  });

  it("keeps the first model item per uncovered topic and unknown items as-is", () => {
    expect(mergeMissing([], ["2 quotes", "another quote", "delivery date"])).toEqual([
      "2 quotes",
      "delivery date",
    ]);
    expect(topicOf("delivery date")).toBeNull();
    expect(topicOf("license_user_list")).toBe(topicOf("list of licence users"));
  });
});

describe("renderSummary", () => {
  const base: ReviewResult = {
    run_id: "r",
    status: "completed",
    decision: "recommend_reject",
    confidence: 0.95,
    request: makeRequest(),
    checks: [
      { check_id: "vendor", status: "fail", detail: "ShadyCorp is blacklisted.", evidence: [] },
    ],
    violations: [
      { rule_id: "VEN-001#3.1", severity: "high", detail: "Blacklisted.", evidence: [] },
    ],
    missing_information: [],
    approval_route: ["department_head", "finance"],
    recommendations: ["Use an approved vendor."],
    flags: ["prompt_injection_suspected"],
    verification: {
      verifier_model: null,
      verdict: "ok",
      unsupported_claims: [],
      invalid_evidence: [],
      notes: "",
      revisions: 0,
    },
    prompt_version: "v1",
    summary: "",
    error: null,
  };

  it("renders decision, checks, violations, route and flags", () => {
    const s = renderSummary(base);
    expect(s).toMatch(/^Recommendation: RECOMMEND REJECTION \(confidence 95%\)/);
    expect(s).toMatch(/\[FAIL\] vendor: ShadyCorp is blacklisted\./);
    expect(s).toMatch(/\[high\] VEN-001#3\.1/);
    expect(s).toMatch(/Approval route: department head → finance/);
    expect(s).toMatch(/Flags: prompt_injection_suspected/);
    expect(s).toMatch(/final decision is made by the approvers/);
  });

  it("explains invalid input, refusals and errors", () => {
    expect(renderSummary({ ...base, status: "invalid_input" }, "empty_request")).toMatch(
      /request is empty/,
    );
    expect(
      renderSummary({
        ...base,
        status: "refused",
        request: makeRequest({ off_topic_reason: "a poem" }),
      }),
    ).toMatch(/only reviews purchase requests.*a poem/);
    expect(renderSummary({ ...base, error: "agent failed" })).toMatch(
      /review was incomplete \(agent failed\)/,
    );
  });
});
