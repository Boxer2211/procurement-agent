/** compose: merge LLM draft + hard rules + verification into the final ReviewResult. */

import {
  type Check,
  checkSeverity,
  type Decision,
  mostSevere,
  type ReviewResult,
  ReviewResultSchema,
  type Verification,
  type Violation,
} from "../../domain/schemas.js";
import { type GraphDeps, makeStep } from "../deps.js";
import type { State, Update } from "../state.js";
import { renderSummary } from "./summary.js";

export function mergeChecks(draft: readonly Check[], rules: readonly Check[]): Check[] {
  const merged = new Map<string, Check>();
  for (const c of draft) merged.set(c.check_id, { ...c, evidence: [...c.evidence] });
  for (const r of rules) {
    const existing = merged.get(r.check_id);
    if (!existing) {
      merged.set(r.check_id, { ...r });
      continue;
    }
    const evidence = [...new Set([...existing.evidence, ...r.evidence])];
    // Deterministic facts win when they are at least as severe as the model's view.
    if (checkSeverity(r.status) >= checkSeverity(existing.status) && r.status !== "unknown") {
      merged.set(r.check_id, { ...r, evidence });
    } else {
      merged.set(r.check_id, { ...existing, evidence });
    }
  }
  return [...merged.values()];
}

export function mergeViolations(
  draft: readonly Violation[],
  rules: readonly Violation[],
): Violation[] {
  const out = [...rules];
  for (const v of draft) if (!out.some((r) => r.rule_id === v.rule_id)) out.push(v);
  return out;
}

const uniq = (items: readonly string[]) => {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = i.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * Topics of "missing information" items. Rule items are canonical (exact counts, doc ids); a
 * model item on a topic the rules already cover is a paraphrase and is dropped, so the requester
 * never sees "3 more quotes" next to "2 additional quotes".
 */
const MISSING_TOPICS: ReadonlyArray<readonly [string, RegExp]> = [
  ["quotes", /\bquot(e|es|ation)/i],
  ["cost_center", /cost[\s_-]*cent(er|re)/i],
  ["justification", /justif/i],
  ["specification", /\bspec(ification|s)?\b/i],
  ["statement_of_work", /statement[\s_-]*of[\s_-]*work|\bsow\b/i],
  ["nda", /\bnda\b|non[\s_-]*disclosure/i],
  ["msa", /master[\s_-]*services|\bmsa\b/i],
  ["security_assessment", /security/i],
  ["vendor_onboarding", /onboard/i],
  ["budget_line", /budget[\s_-]*line/i],
  ["license_user_list", /licen[cs]e[\s_-]*users?|users?[\s_-]*list|named[\s_-]*users/i],
  ["tender", /\b(rfp|tender)\b/i],
];

const normalizeItem = (item: string) =>
  item
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, " ");

export function topicOf(item: string): string | null {
  return MISSING_TOPICS.find(([, re]) => re.test(item.replace(/_/g, " ")))?.[0] ?? null;
}

export function mergeMissing(rules: readonly string[], draft: readonly string[]): string[] {
  const out = uniq(rules);
  const covered = new Set(out.map(topicOf).filter((t): t is string => t !== null));
  const seen = new Set(out.map(normalizeItem));
  for (const item of draft) {
    const key = normalizeItem(item);
    const topic = topicOf(item);
    if (!key || seen.has(key) || (topic && covered.has(topic))) continue;
    seen.add(key);
    if (topic) covered.add(topic);
    out.push(item);
  }
  return out;
}

const SKIPPED: Verification = {
  verifier_model: null,
  verdict: "skipped",
  unsupported_claims: [],
  invalid_evidence: [],
  notes: "",
  revisions: 0,
};

export function composeResult(state: State, promptVersion: string): ReviewResult {
  const base = {
    run_id: state.runId,
    request: state.request,
    checks: [] as Check[],
    violations: [] as Violation[],
    missing_information: [] as string[],
    approval_route: [] as string[],
    recommendations: [] as string[],
    flags: state.flags,
    verification: state.verification ?? SKIPPED,
    prompt_version: promptVersion,
    summary: "",
    error: state.error,
  };

  if (state.inputError) {
    return { ...base, status: "invalid_input", decision: "needs_info", confidence: 1, error: null };
  }
  if (state.request && state.flags.includes("off_topic")) {
    return { ...base, status: "refused", decision: "refused", confidence: 0.9 };
  }
  if (!state.request) {
    return { ...base, status: "error", decision: "escalate_to_human", confidence: 0 };
  }

  const draft = state.draft;
  const rules = state.ruleOutcome;
  const verificationFailed = state.flags.includes("verification_failed");
  const draftDecision: Decision = draft?.decision ?? "escalate_to_human";
  const decision = mostSevere(
    draftDecision,
    rules?.floor ?? "escalate_to_human",
    verificationFailed || state.flags.includes("iteration_limit")
      ? "escalate_to_human"
      : "recommend_approve",
  );

  let confidence = draft ? Math.min(Math.max(draft.confidence, 0), 1) : 0.3;
  if (decision !== draftDecision && rules && rules.floor === decision) confidence = 0.95;
  if (verificationFailed) confidence *= 0.6;

  return {
    ...base,
    status: state.error ? "error" : "completed",
    decision,
    confidence: Math.round(confidence * 100) / 100,
    checks: mergeChecks(draft?.checks ?? [], rules?.checks ?? []),
    violations: mergeViolations(draft?.violations ?? [], rules?.violations ?? []),
    missing_information: mergeMissing(rules?.missing ?? [], draft?.missing_information ?? []),
    approval_route: state.ruleFacts?.route?.value.approvers ?? [],
    recommendations: uniq([...(rules?.recommendations ?? []), ...(draft?.recommendations ?? [])]),
  };
}

export const makeComposeNode =
  (deps: GraphDeps) =>
  (state: State): Update => {
    const result = composeResult(state, deps.settings.PROMPT_VERSION);
    const final = ReviewResultSchema.parse({
      ...result,
      summary: renderSummary(result, state.inputError),
    });
    return {
      result: final,
      steps: [
        makeStep("compose", "info", "compose", {
          output: {
            status: final.status,
            decision: final.decision,
            confidence: final.confidence,
            flags: final.flags,
          },
        }),
      ],
    };
  };

export const routeAfterCompose =
  (deps: GraphDeps) =>
  (state: State): "human" | "__end__" =>
    deps.settings.HUMAN_REVIEW && state.result?.status === "completed" ? "human" : "__end__";
