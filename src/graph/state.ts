/** LangGraph state for one review run. */

import { Annotation } from "@langchain/langgraph";
import type { TraceStep } from "../db/stores.js";
import type {
  AgentDraft,
  Flag,
  PurchaseRequest,
  RequestContext,
  ReviewPlan,
  ReviewResult,
  Verification,
} from "../domain/schemas.js";
import type { InputRejectReason } from "../guardrails/input.js";
import type { ChatMessage, LLMUsage, ToolUseBlock } from "../llm/types.js";
import type { Facts, RuleOutcome } from "../rules/engine.js";

export interface ToolCallRecord {
  evidenceId: string; // "tool:<name>#<n>"
  toolUseId: string | null; // null when called by the orchestrator (facts node)
  name: string;
  input: unknown;
  ok: boolean;
  output: unknown;
  error: string | null;
  internalError: string | null;
  initiator: "agent" | "orchestrator";
}

export type NewStep = Omit<TraceStep, "seq">;

export interface HumanDecision {
  decision: "approve" | "reject" | "request_info";
  approver: string;
  comment: string | null;
  decidedAt: string;
}

const concat = <T>() => ({
  reducer: (a: T[], b: T[]) => a.concat(b),
  default: (): T[] => [],
});

export const ReviewState = Annotation.Root({
  runId: Annotation<string>,
  rawText: Annotation<string>,
  context: Annotation<RequestContext | null>,

  // guard
  text: Annotation<string>,
  inputError: Annotation<InputRejectReason | null>,
  flags: Annotation<Flag[]>({
    reducer: (a, b) => [...new Set([...a, ...b])],
    default: () => [],
  }),
  signals: Annotation<Record<string, string[]>>({
    reducer: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),

  // extract / plan
  request: Annotation<PurchaseRequest | null>,
  reviewPlan: Annotation<ReviewPlan | null>,

  // agent loop
  messages: Annotation<ChatMessage[]>(concat<ChatMessage>()),
  pendingToolUses: Annotation<ToolUseBlock[]>,
  toolCalls: Annotation<ToolCallRecord[]>(concat<ToolCallRecord>()),
  iterations: Annotation<number>,
  formatRetries: Annotation<number>,
  /** Explicit routing signal set by the agent node (no routing logic hidden in nodes). */
  agentNext: Annotation<"tools" | "agent" | "done">,
  draft: Annotation<AgentDraft | null>,

  // deterministic layer
  ruleFacts: Annotation<Facts | null>,
  ruleOutcome: Annotation<RuleOutcome | null>,

  // verification
  verification: Annotation<Verification | null>,
  revisions: Annotation<number>,

  // output
  result: Annotation<ReviewResult | null>,
  error: Annotation<string | null>,
  humanDecision: Annotation<HumanDecision | null>,

  // observability
  usage: Annotation<LLMUsage>({
    reducer: (a, b) => ({
      inputTokens: a.inputTokens + b.inputTokens,
      outputTokens: a.outputTokens + b.outputTokens,
    }),
    default: () => ({ inputTokens: 0, outputTokens: 0 }),
  }),
  steps: Annotation<TraceStep[], NewStep[]>({
    reducer: (a, b) => a.concat(b.map((s, i) => ({ ...s, seq: a.length + i + 1 }))),
    default: () => [],
  }),
});

export type State = typeof ReviewState.State;
export type Update = typeof ReviewState.Update;

export function initialState(
  runId: string,
  rawText: string,
  context: RequestContext | null,
): Update {
  return {
    runId,
    rawText,
    context,
    text: "",
    inputError: null,
    request: null,
    reviewPlan: null,
    pendingToolUses: [],
    iterations: 0,
    formatRetries: 0,
    agentNext: "done",
    draft: null,
    ruleFacts: null,
    ruleOutcome: null,
    verification: null,
    revisions: 0,
    result: null,
    error: null,
    humanDecision: null,
  };
}
