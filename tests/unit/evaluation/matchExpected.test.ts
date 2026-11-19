import { describe, expect, it } from "vitest";
import type { ReviewResult } from "../../../src/domain/schemas.js";
import { matchExpected } from "../../../src/evaluation/matchExpected.js";

const result = {
  status: "completed",
  decision: "needs_info",
  checks: [{ check_id: "quotes", status: "fail", detail: "", evidence: [] }],
  missing_information: ["Cost center", "2 additional vendor quotes"],
  flags: ["prompt_injection_suspected"],
  violations: [{ rule_id: "PROC-001#4.2", severity: "low", detail: "", evidence: [] }],
  approval_route: ["department_head", "finance"],
} as unknown as ReviewResult;

describe("matchExpected", () => {
  it("passes when every expectation holds", () => {
    expect(
      matchExpected(result, {
        status: "completed",
        decision: "needs_info",
        decisionOneOf: ["needs_info", "escalate_to_human"],
        decisionMustNotBe: ["recommend_approve"],
        mustIncludeChecks: { quotes: "fail" },
        mustIncludeMissing: ["cost center", "quote"],
        mustIncludeFlags: ["prompt_injection_suspected"],
        mustNotIncludeFlags: ["off_topic"],
        mustIncludeViolations: ["PROC-001#4.2"],
        approvalRoute: ["department_head", "finance"],
      }),
    ).toEqual([]);
  });

  it("reports every mismatch", () => {
    const problems = matchExpected(result, {
      status: "refused",
      decision: "recommend_reject",
      decisionMustNotBe: ["needs_info"],
      mustIncludeChecks: { budget: "pass" },
      mustIncludeMissing: ["nda"],
      mustIncludeFlags: ["off_topic"],
      mustNotIncludeFlags: ["prompt_injection_suspected"],
      mustIncludeViolations: ["VEN-001#3.1"],
      approvalRoute: ["cfo"],
    });
    expect(problems).toHaveLength(9);
  });

  it("rejects unknown expectation keys", () => {
    expect(() => matchExpected(result, { nope: 1 } as never)).toThrow();
  });
});
