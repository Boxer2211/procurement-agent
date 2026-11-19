import { describe, expect, it } from "vitest";
import type { AgentDraft } from "../../../src/domain/schemas.js";
import { findInvalidEvidence, isWellFormedEvidence } from "../../../src/guardrails/output.js";

function draft(partial: Partial<AgentDraft>): AgentDraft {
  return {
    decision: "needs_info",
    confidence: 0.8,
    checks: [],
    violations: [],
    missing_information: [],
    recommendations: [],
    ...partial,
  };
}

const KNOWN = ["tool:get_budget#1", "policy:PROC-001#4.2", "policy:PROC-002#2.3"];

describe("isWellFormedEvidence", () => {
  it.each(["tool:get_budget#1", "policy:PROC-001#4.2", "policy:HW-STD-001", "policy:BUD-001#1.1"])(
    "accepts %s",
    (ref) => expect(isWellFormedEvidence(ref)).toBe(true),
  );
  it.each(["tool:get_budget", "PROC-001#4.2", "policy:proc-001", "https://x", "tool:Get#1"])(
    "rejects %s",
    (ref) => expect(isWellFormedEvidence(ref)).toBe(false),
  );
});

describe("findInvalidEvidence", () => {
  it("accepts evidence that was produced in this run", () => {
    const d = draft({
      checks: [
        { check_id: "budget", status: "pass", detail: "", evidence: ["tool:get_budget#1"] },
        { check_id: "quotes", status: "fail", detail: "", evidence: ["policy:PROC-001#4.2"] },
      ],
    });
    expect(findInvalidEvidence(d, KNOWN)).toEqual([]);
  });

  it("accepts a policy-level ref when a chunk of that policy is known", () => {
    const d = draft({
      checks: [{ check_id: "quotes", status: "fail", detail: "", evidence: ["policy:PROC-001"] }],
    });
    expect(findInvalidEvidence(d, KNOWN)).toEqual([]);
  });

  it("reports hallucinated, malformed and duplicate refs once", () => {
    const d = draft({
      checks: [
        { check_id: "vendor", status: "pass", detail: "", evidence: ["tool:check_vendor#7"] },
        {
          check_id: "price",
          status: "warn",
          detail: "",
          evidence: ["policy:HW-STD-001#2.2", "bad ref"],
        },
        { check_id: "budget", status: "pass", detail: "", evidence: ["tool:check_vendor#7"] },
      ],
    });
    expect(findInvalidEvidence(d, KNOWN)).toEqual([
      "tool:check_vendor#7",
      "policy:HW-STD-001#2.2",
      "bad ref",
    ]);
  });

  it("requires violation rule ids to come from retrieved policies", () => {
    const d = draft({
      violations: [
        { rule_id: "PROC-001#5.1", severity: "high", detail: "", evidence: [] },
        { rule_id: "SVC-001#2.1", severity: "medium", detail: "", evidence: [] },
      ],
    });
    expect(findInvalidEvidence(d, KNOWN)).toEqual(["policy:SVC-001#2.1"]);
  });
});
