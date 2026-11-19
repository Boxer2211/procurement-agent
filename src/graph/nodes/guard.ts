/** guard: deterministic input validation and abuse/injection detection. No LLM. */

import { scanRequest } from "../../guardrails/injection.js";
import { validateInput } from "../../guardrails/input.js";
import { type GraphDeps, makeStep, timer } from "../deps.js";
import type { State, Update } from "../state.js";

export const makeGuardNode =
  (deps: GraphDeps) =>
  (state: State): Update => {
    const elapsed = timer();
    const checked = validateInput(state.rawText, deps.settings.MAX_INPUT_CHARS);
    if (!checked.ok) {
      return {
        text: checked.text,
        inputError: checked.reason,
        steps: [
          makeStep("guard", "guard", "validate_input", {
            error: checked.reason,
            durationMs: elapsed(),
          }),
        ],
      };
    }
    const scan = scanRequest(checked.text);
    return {
      text: checked.text,
      inputError: null,
      flags: scan.flags,
      signals: scan.signals,
      steps: [
        makeStep("guard", "guard", "validate_input", {
          output: { chars: checked.text.length, flags: scan.flags, signals: scan.signals },
          durationMs: elapsed(),
        }),
      ],
    };
  };

export const routeAfterGuard = (state: State): "extract" | "compose" =>
  state.inputError ? "compose" : "extract";
