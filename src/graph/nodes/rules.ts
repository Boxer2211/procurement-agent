/** rules: deterministic hard rules over the facts; computes the decision floor. */

import { evaluateRules } from "../../rules/engine.js";
import { makeStep, timer } from "../deps.js";
import type { State, Update } from "../state.js";

export const rulesNode = (state: State): Update => {
  if (!state.request || !state.ruleFacts) return { ruleOutcome: null };
  const elapsed = timer();
  const outcome = evaluateRules(state.request, state.ruleFacts, state.flags);
  return {
    ruleOutcome: outcome,
    flags: outcome.flags,
    steps: [
      makeStep("rules", "rule", "evaluate_rules", {
        output: { floor: outcome.floor, hits: outcome.hits },
        durationMs: elapsed(),
      }),
    ],
  };
};
