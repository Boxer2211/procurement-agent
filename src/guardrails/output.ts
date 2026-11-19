/** Deterministic checks on LLM output: evidence references must point at real evidence. */

import type { AgentDraft } from "../domain/schemas.js";

const EVIDENCE = /^(tool:[a-z_]+#\d+|policy:[A-Z0-9-]+(?:#[\d.]+)?)$/;

export function isWellFormedEvidence(ref: string): boolean {
  return EVIDENCE.test(ref);
}

export function collectEvidenceRefs(draft: AgentDraft): string[] {
  return [
    ...draft.checks.flatMap((c) => c.evidence),
    ...draft.violations.flatMap((v) => v.evidence),
  ];
}

const policyOf = (ref: string): string => ref.split("#", 1)[0] ?? ref;

/**
 * Return evidence refs that are malformed or were never produced in this run.
 *
 * - A policy-level ref (`policy:PROC-001`) is accepted if any chunk of that policy is known.
 * - A violation's `rule_id` must be a known chunk, or belong to a policy that is known.
 */
export function findInvalidEvidence(draft: AgentDraft, known: Iterable<string>): string[] {
  const knownSet = new Set(known);
  const knownPolicies = new Set(
    [...knownSet].filter((k) => k.startsWith("policy:")).map((k) => policyOf(k)),
  );
  const invalid: string[] = [];
  const add = (ref: string) => {
    if (!invalid.includes(ref)) invalid.push(ref);
  };

  const accept = (ref: string): boolean => {
    if (!isWellFormedEvidence(ref)) return false;
    if (knownSet.has(ref)) return true;
    return ref.startsWith("policy:") && !ref.includes("#") && knownPolicies.has(ref);
  };

  for (const ref of collectEvidenceRefs(draft)) {
    if (!accept(ref)) add(ref);
  }
  for (const v of draft.violations) {
    const ruleRef = `policy:${v.rule_id}`;
    if (!knownSet.has(ruleRef) && !knownPolicies.has(policyOf(ruleRef))) add(ruleRef);
  }
  return invalid;
}
