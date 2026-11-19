/**
 * Semantic comparison of a ReviewResult with an expected-outcome file. Used by the e2e
 * tests (scripted LLM) and the live evals (real model): free text is never compared.
 */

import { z } from "zod";
import {
  CheckStatusSchema,
  DecisionSchema,
  FlagSchema,
  type ReviewResult,
  RunStatusSchema,
} from "../domain/schemas.js";

export const ExpectedSchema = z
  .object({
    status: RunStatusSchema.optional(),
    decision: DecisionSchema.optional(),
    decisionOneOf: z.array(DecisionSchema).optional(),
    decisionMustNotBe: z.array(DecisionSchema).optional(),
    mustIncludeChecks: z.record(z.string(), CheckStatusSchema).optional(),
    mustIncludeMissing: z.array(z.string()).optional(),
    mustIncludeFlags: z.array(FlagSchema).optional(),
    mustNotIncludeFlags: z.array(FlagSchema).optional(),
    mustIncludeViolations: z.array(z.string()).optional(),
    approvalRoute: z.array(z.string()).optional(),
  })
  .strict();
export type Expected = z.infer<typeof ExpectedSchema>;

/** Returns human-readable mismatches; an empty list means the result matches. */
export function matchExpected(result: ReviewResult, expected: Expected): string[] {
  const problems: string[] = [];
  const e = ExpectedSchema.parse(expected);

  if (e.status && result.status !== e.status)
    problems.push(`status: expected ${e.status}, got ${result.status}`);
  if (e.decision && result.decision !== e.decision) {
    problems.push(`decision: expected ${e.decision}, got ${result.decision}`);
  }
  if (e.decisionOneOf && !e.decisionOneOf.includes(result.decision)) {
    problems.push(`decision: expected one of ${e.decisionOneOf.join("|")}, got ${result.decision}`);
  }
  if (e.decisionMustNotBe?.includes(result.decision)) {
    problems.push(`decision: must not be ${result.decision}`);
  }
  for (const [checkId, status] of Object.entries(e.mustIncludeChecks ?? {})) {
    const actual = result.checks.find((c) => c.check_id === checkId)?.status;
    if (actual !== status)
      problems.push(`check ${checkId}: expected ${status}, got ${actual ?? "missing"}`);
  }
  const missingText = result.missing_information.join(" | ").toLowerCase();
  for (const m of e.mustIncludeMissing ?? []) {
    if (!missingText.includes(m.toLowerCase()))
      problems.push(`missing_information: expected to mention "${m}"`);
  }
  for (const f of e.mustIncludeFlags ?? []) {
    if (!result.flags.includes(f)) problems.push(`flags: expected ${f}`);
  }
  for (const f of e.mustNotIncludeFlags ?? []) {
    if (result.flags.includes(f)) problems.push(`flags: unexpected ${f}`);
  }
  for (const v of e.mustIncludeViolations ?? []) {
    if (!result.violations.some((x) => x.rule_id === v)) problems.push(`violations: expected ${v}`);
  }
  if (
    e.approvalRoute &&
    JSON.stringify(result.approval_route) !== JSON.stringify(e.approvalRoute)
  ) {
    problems.push(
      `approval_route: expected ${e.approvalRoute.join(",")}, got ${result.approval_route.join(",")}`,
    );
  }
  return problems;
}
