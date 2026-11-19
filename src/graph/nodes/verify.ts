/**
 * verify: deterministic citation check + an independent LLM (different model) that checks the
 * draft is grounded in the evidence. Fixable problems send the draft back to the agent once.
 */

import { type AgentDraft, type Verification, VerifierOutputSchema } from "../../domain/schemas.js";
import { findInvalidEvidence } from "../../guardrails/output.js";
import { loadPrompt, wrapJson } from "../../llm/prompting.js";
import { completeStructured, type GraphDeps, makeStep, rethrowIfRetryable } from "../deps.js";
import type { NewStep, State, ToolCallRecord, Update } from "../state.js";

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

/** Every evidence id and policy rule id surfaced by successful tool calls in this run. */
export function knownEvidence(calls: readonly ToolCallRecord[]): Set<string> {
  const known = new Set<string>();
  const addRule = (id: unknown) => {
    if (typeof id === "string" && id) known.add(`policy:${id}`);
  };
  for (const c of calls) {
    if (!c.ok) continue;
    known.add(c.evidenceId);
    const out = asRecord(c.output);
    addRule(out.rule_id);
    addRule(out.policy_ref);
    if (Array.isArray(out.rule_ids)) for (const id of out.rule_ids) addRule(id);
    if (Array.isArray(out.documents)) {
      for (const d of out.documents) addRule(asRecord(d).rule_id);
    }
    if (Array.isArray(out.results)) {
      for (const r of out.results) {
        const id = asRecord(r).evidence_id;
        if (typeof id === "string") known.add(id);
      }
    }
  }
  return known;
}

/** Evidence pack for the verifier: tool outputs and policy excerpts keyed by evidence id. */
export function evidencePack(calls: readonly ToolCallRecord[]): Record<string, unknown> {
  const pack: Record<string, unknown> = {};
  for (const c of calls) {
    if (!c.ok) continue;
    const out = asRecord(c.output);
    if (c.name === "search_policies" && Array.isArray(out.results)) {
      for (const r of out.results) {
        const rec = asRecord(r);
        if (typeof rec.evidence_id === "string")
          pack[rec.evidence_id] = { heading: rec.heading, text: rec.text };
      }
    } else {
      pack[c.evidenceId] = { tool: c.name, input: c.input, output: c.output };
    }
  }
  return pack;
}

function feedbackMessage(invalid: string[], claims: { claim: string; reason: string }[]): string {
  const lines = [
    "An independent reviewer checked your answer against the evidence and found problems:",
    ...invalid.map(
      (ref) =>
        `- Evidence id "${ref}" was not produced in this conversation. Cite only ids returned by tools.`,
    ),
    ...claims.map((c) => `- ${c.claim}: ${c.reason}`),
    "Fix these issues (call tools again if you need evidence) and give a corrected final answer.",
  ];
  return lines.join("\n");
}

export const makeVerifyNode =
  (deps: GraphDeps) =>
  async (state: State): Promise<Update> => {
    const s = deps.settings;
    const draft: AgentDraft | null = state.draft;
    if (!draft) {
      const verification: Verification = {
        verifier_model: null,
        verdict: "skipped",
        unsupported_claims: [],
        invalid_evidence: [],
        notes: "No draft to verify.",
        revisions: state.revisions,
      };
      return { verification, agentNext: "done" };
    }

    const steps: NewStep[] = [];
    const invalid = findInvalidEvidence(draft, knownEvidence(state.toolCalls));
    steps.push(makeStep("verify", "guard", "citation_check", { output: { invalid } }));

    let llmVerdict: "ok" | "revise" | "unsupported" | "skipped" = "skipped";
    let claims: { claim: string; reason: string }[] = [];
    let notes = "";
    let usage = { inputTokens: 0, outputTokens: 0 };
    try {
      const res = await completeStructured(deps.llm, {
        node: "verify",
        model: s.VERIFIER_MODEL,
        effort: s.VERIFIER_EFFORT,
        maxTokens: 4000,
        system: loadPrompt("verify", s.PROMPT_VERSION),
        messages: [
          {
            role: "user",
            content: [
              wrapJson("draft", draft),
              wrapJson("evidence", evidencePack(state.toolCalls)),
            ].join("\n\n"),
          },
        ],
        outputSchema: VerifierOutputSchema,
      });
      usage = res.usage;
      steps.push(...res.steps);
      if (res.value) {
        llmVerdict = res.value.verdict;
        claims = res.value.unsupported_claims;
        notes = res.value.notes;
      } else {
        notes = res.error ?? "verifier returned no verdict";
      }
    } catch (err) {
      rethrowIfRetryable(err);
      notes = `verifier unavailable: ${err instanceof Error ? err.message : String(err)}`;
      steps.push(makeStep("verify", "llm", "verify", { error: notes }));
    }

    const needsRevision =
      invalid.length > 0 || llmVerdict === "revise" || llmVerdict === "unsupported";
    const base: Verification = {
      verifier_model: s.VERIFIER_MODEL,
      verdict: needsRevision
        ? llmVerdict === "unsupported"
          ? "unsupported"
          : "revise"
        : llmVerdict,
      unsupported_claims: claims,
      invalid_evidence: invalid,
      notes,
      revisions: state.revisions,
    };

    if (needsRevision && state.revisions < s.MAX_REVISIONS) {
      return {
        verification: base,
        messages: [{ role: "user", content: feedbackMessage(invalid, claims) }],
        draft: null,
        revisions: state.revisions + 1,
        iterations: 0,
        formatRetries: 0,
        agentNext: "agent",
        usage,
        steps: [
          ...steps,
          makeStep("verify", "info", "request_revision", { output: { invalid, claims } }),
        ],
      };
    }
    return {
      verification: base,
      agentNext: "done",
      flags: needsRevision ? ["verification_failed"] : [],
      usage,
      steps,
    };
  };

export const routeAfterVerify = (state: State): "agent" | "compose" =>
  state.agentNext === "agent" && state.draft === null ? "agent" : "compose";
