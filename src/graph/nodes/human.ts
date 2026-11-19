/** human: human-in-the-loop. The graph pauses here until an approver submits a decision. */

import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { makeStep } from "../deps.js";
import type { State, Update } from "../state.js";

export const HumanDecisionInputSchema = z
  .object({
    decision: z.enum(["approve", "reject", "request_info"]),
    approver: z.string().min(1).max(128),
    comment: z.string().max(2000).nullable().default(null),
  })
  .strict();
export type HumanDecisionInput = z.infer<typeof HumanDecisionInputSchema>;

export const humanNode = (state: State): Update => {
  const raw: unknown = interrupt({ runId: state.runId, recommendation: state.result?.decision });
  const input = HumanDecisionInputSchema.parse(raw);
  const humanDecision = { ...input, decidedAt: new Date().toISOString() };
  return {
    humanDecision,
    steps: [makeStep("human", "info", "human_decision", { output: humanDecision })],
  };
};
